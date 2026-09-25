import { futureDef, futureMarginPerContract } from "@mock-kabu/shared";
import { describe, expect, it } from "vitest";
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
});

describe("setting leverage", () => {
  function service(position: { qty: number } | null, liveOrders = 0) {
    const saved: unknown[] = [];
    const tx = {
      futuresPosition: {
        findUnique: async () => position,
        upsert: async (args: unknown) => saved.push(args),
      },
      order: { count: async () => liveOrders },
    };
    const prisma = { $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) };
    return { svc: new FuturesService(prisma as never, {} as never), saved };
  }

  it("stores 1~20x, or null for the exchange rate", async () => {
    const { svc, saved } = service(null);
    await expect(svc.setLeverage("a", "USDF", 20)).resolves.toEqual({ symbol: "USDF", leverage: 20 });
    await expect(svc.setLeverage("a", "USDF", null)).resolves.toEqual({ symbol: "USDF", leverage: null });
    expect(saved).toHaveLength(2);
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
});
