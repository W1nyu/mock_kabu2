import { futureDef, futureMarginPerContract } from "@mock-kabu/shared";
import { describe, expect, it, vi } from "vitest";
import { futuresOrderHoldPerUnit } from "../../order/futures-margin";
import { FuturesService } from "../futures.service";

const USDF = futureDef("USDF")!;

function db(position: { qty: number; leverage: number | null } | null, pending: { qty: number; filledQty: number }[] = []) {
  return {
    futuresPosition: { findUnique: async () => position },
    order: { findMany: async () => pending },
  };
}

describe("futures order hold", () => {
  it("opening orders hold initial margin at the symbol's leverage", async () => {
    expect(await futuresOrderHoldPerUnit(db({ qty: 0, leverage: 20 }), "a", USDF, "BUY", 1, 14_000)).toBe(700_000n);
    expect(await futuresOrderHoldPerUnit(db(null), "a", USDF, "BUY", 1, 14_000)).toBe(futureMarginPerContract(USDF, 14_000));
    // 롱에 매수를 더하는 것도 신규
    expect(await futuresOrderHoldPerUnit(db({ qty: 3, leverage: 20 }), "a", USDF, "BUY", 1, 14_000)).toBe(700_000n);
  });

  it("closing orders within the open position hold nothing, like a real broker", async () => {
    expect(await futuresOrderHoldPerUnit(db({ qty: 3, leverage: 20 }), "a", USDF, "SELL", 3, 14_000)).toBe(0n);
    expect(await futuresOrderHoldPerUnit(db({ qty: -2, leverage: null }), "a", USDF, "BUY", 2, 14_000)).toBe(0n);
  });

  it("closing beyond the position, or beyond what earlier closing orders already cover, holds margin", async () => {
    // 3계약 롱에 4계약 매도 = 뒤집기 → 전부 증거금
    expect(await futuresOrderHoldPerUnit(db({ qty: 3, leverage: 20 }), "a", USDF, "SELL", 4, 14_000)).toBe(700_000n);
    // 이미 2계약 청산 지정가가 걸려 있으면 남은 1계약까지만 무증거금
    const pending = [{ qty: 2, filledQty: 0 }];
    expect(await futuresOrderHoldPerUnit(db({ qty: 3, leverage: 20 }, pending), "a", USDF, "SELL", 1, 14_000)).toBe(0n);
    expect(await futuresOrderHoldPerUnit(db({ qty: 3, leverage: 20 }, pending), "a", USDF, "SELL", 2, 14_000)).toBe(700_000n);
  });

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
});

describe("setting leverage", () => {
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

  it("stores 1~20x, or null for the exchange rate", async () => {
    const { svc, saved } = service(null);
    await expect(svc.setLeverage("a", "USDF", 20)).resolves.toEqual({ symbol: "USDF", leverage: 20 });
    await expect(svc.setLeverage("a", "USDF", null)).resolves.toEqual({ symbol: "USDF", leverage: null });
    // 사람 계정은 두 번 × 롱·숏 두 행
    expect(saved).toHaveLength(4);
  });

  it("rejects values outside 1~20 and unknown symbols", async () => {
    const { svc } = service(null);
    await expect(svc.setLeverage("a", "USDF", 21)).rejects.toThrow(/1~20배/);
    await expect(svc.setLeverage("a", "USDF", 0)).rejects.toThrow(/1~20배/);
    await expect(svc.setLeverage("a", "USDF", 2.5)).rejects.toThrow(/1~20배/);
    await expect(svc.setLeverage("a", "KABU", 5)).rejects.toThrow(/없는 선물/);
  });

  it("cannot change while a position or a live order exists", async () => {
    await expect(service({ qty: 1 }).svc.setLeverage("a", "USDF", 10)).rejects.toThrow(/포지션이 있는 동안/);
    await expect(service({ qty: 0 }, 1).svc.setLeverage("a", "USDF", 10)).rejects.toThrow(/미체결 주문/);
  });

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
});

describe("futures positions view", () => {
  it("lists each hedge side with its direction and the quantity not yet covered by closing orders", async () => {
    const prisma = {
      futuresPosition: {
        findMany: async () => [
          { accountId: "a", symbol: "USDF", positionSide: "LONG", qty: 3, entryValue: 42_000n, marginHeld: 2_100_000n, leverage: null },
          { accountId: "a", symbol: "USDF", positionSide: "SHORT", qty: -2, entryValue: 28_000n, marginHeld: 1_400_000n, leverage: null },
        ],
        aggregate: async () => ({ _sum: { marginHeld: 3_500_000n } }),
      },
      futuresDebt: { findUnique: async () => null },
      account: { findUnique: async () => ({ balance: 10_000_000n, holdAmount: 0n }) },
      futuresMarginCall: { findFirst: async () => null },
      futuresLiquidation: { findMany: async () => [] },
      order: {
        findMany: async () => [
          // 롱 청산(매도) 2 중 1 체결 → 1 남음. 숏 진입 매도(positionSide SHORT)는 롱 청산이 아니다.
          { symbol: "USDF", side: "SELL", positionSide: "LONG", qty: 2, filledQty: 1 },
          { symbol: "USDF", side: "SELL", positionSide: "SHORT", qty: 5, filledQty: 0 },
          { symbol: "USDF", side: "BUY", positionSide: "SHORT", qty: 2, filledQty: 0 },
        ],
      },
    };
    const svc = new FuturesService(prisma as never, {} as never);
    vi.spyOn(svc, "marks").mockResolvedValue(new Map([["USDF", 14_000]]));
    const view = await svc.positions("a");
    expect(view.positions.map((p) => [p.symbol, p.positionSide, p.qty, p.closableQty])).toEqual([
      ["USDF", "LONG", 3, 2],
      ["USDF", "SHORT", -2, 0],
    ]);
    expect(view.positions[0]).toMatchObject({ avgPrice: 14_000, markPrice: 14_000, marginHeld: 2_100_000n });
  });
});
