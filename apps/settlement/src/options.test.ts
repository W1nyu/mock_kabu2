import { describe, expect, it } from "vitest";
import { optionDef, optionWriterMarginPerContract, type TradeExecutedEvent } from "@mock-kabu/shared";
import type { FuturesLockContext } from "./futures";
import { settleOptionTrade } from "./options";

const KC3 = optionDef("KC3")!;
const STRIKE = 300_000; // 3,000.00pt

/** 메모리 위의 계좌·포지션·원장 — Prisma 델리게이트 모양만 흉내 낸다. */
function fakeContext(accounts: Record<string, { balance: bigint; holdAmount: bigint }>) {
  const positions = new Map<string, { qty: number; entryValue: bigint; marginHeld: bigint }>();
  const ledger: { accountId: string; delta: bigint; reason: string }[] = [];
  const realized: { accountId: string; side: string; realized: bigint }[] = [];
  const key = (w: { accountId_symbol_positionSide: { accountId: string; symbol: string; positionSide: string } }) =>
    `${w.accountId_symbol_positionSide.accountId}:${w.accountId_symbol_positionSide.symbol}:${w.accountId_symbol_positionSide.positionSide}`;
  const ctx: FuturesLockContext = {
    accounts,
    async updateAccount(accountId, next) {
      accounts[accountId] = { ...next };
    },
    tx: {
      optionSeries: { findUnique: async () => ({ symbol: "KC3", strike: STRIKE }) },
      futuresPosition: {
        findUnique: async ({ where }: any) => positions.get(key(where)) ?? null,
        upsert: async ({ where, update, create }: any) => {
          const k = key(where);
          positions.set(k, positions.has(k) ? { ...positions.get(k)!, ...update } : { ...create });
        },
      },
      futuresRealized: { create: async ({ data }: any) => realized.push(data) },
      ledgerEntry: { create: async ({ data }: any) => ledger.push(data) },
      order: { update: async () => undefined },
    },
  };
  return { ctx, positions, ledger, realized, accounts };
}

function trade(price: number, qty: number, buyer: string, seller: string): TradeExecutedEvent {
  return {
    topic: "trade.executed",
    eventId: `e-${price}-${qty}`,
    tradeId: `t-${price}-${qty}`,
    symbol: "KC3",
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

const order = (holdPerUnit: bigint, qty: number) => ({ id: "o", holdPerUnit, status: "OPEN", qty, filledQty: 0 });

describe("option trade settlement", () => {
  it("moves the premium buyer → writer, releases order holds, and holds writer margin on the short", async () => {
    // 사용자 U가 봇 W의 콜을 30.00pt에 2계약 산다: 프리미엄 3,000 × 100 × 2 = 60만 원
    const writerMargin = optionWriterMarginPerContract(KC3, STRIKE);
    const f = fakeContext({
      U: { balance: 1_000_000n, holdAmount: 600_000n },
      W: { balance: 50_000_000n, holdAmount: writerMargin * 2n },
    });
    await settleOptionTrade(f.ctx, KC3, trade(3_000, 2, "U", "W"), order(300_000n, 2), order(writerMargin, 2));

    expect(f.accounts.U).toEqual({ balance: 400_000n, holdAmount: 0n });
    expect(f.accounts.W).toEqual({ balance: 50_600_000n, holdAmount: 0n });
    expect(f.positions.get("U:KC3:NET")).toMatchObject({ qty: 2, entryValue: 6_000n, marginHeld: 0n });
    expect(f.positions.get("W:KC3:NET")).toMatchObject({ qty: -2, entryValue: 6_000n, marginHeld: writerMargin * 2n });
    expect(f.ledger.map((l) => [l.accountId, l.delta, l.reason])).toEqual([
      ["U", -600_000n, "OPTION_PREMIUM"],
      ["W", 600_000n, "OPTION_PREMIUM"],
    ]);
    expect(f.realized).toHaveLength(0);
  });

  it("selling a held option back records realized P&L and frees the writer's margin when it buys back", async () => {
    const writerMargin = optionWriterMarginPerContract(KC3, STRIKE);
    const f = fakeContext({
      U: { balance: 1_000_000n, holdAmount: 600_000n },
      W: { balance: 50_000_000n, holdAmount: writerMargin * 2n },
    });
    await settleOptionTrade(f.ctx, KC3, trade(3_000, 2, "U", "W"), order(300_000n, 2), order(writerMargin, 2));
    // U가 45.00pt에 2계약 청산 매도(홀드 0), W가 되사며 프리미엄 90만 원을 묶었다.
    f.accounts.W.holdAmount += 900_000n;
    await settleOptionTrade(f.ctx, KC3, trade(4_500, 2, "W", "U"), order(450_000n, 2), order(0n, 2));

    expect(f.accounts.U).toEqual({ balance: 1_300_000n, holdAmount: 0n });
    expect(f.accounts.W).toEqual({ balance: 49_700_000n, holdAmount: 0n });
    expect(f.positions.get("U:KC3:NET")).toMatchObject({ qty: 0, entryValue: 0n, marginHeld: 0n });
    expect(f.positions.get("W:KC3:NET")).toMatchObject({ qty: 0, entryValue: 0n, marginHeld: 0n });
    expect(f.realized.map((r) => [r.accountId, r.side, r.realized])).toEqual([
      ["W", "BUY", -300_000n],
      ["U", "SELL", 300_000n],
    ]);
  });
});
