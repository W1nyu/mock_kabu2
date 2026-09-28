import { optionDef } from "@mock-kabu/shared";
import { describe, expect, it } from "vitest";
import { optionOrderHoldPerUnit } from "../futures-margin";

/** 계좌·사용자·포지션·미체결·행사가만 흉내 낸 트랜잭션 */
function fakeDb(options: { isBot: boolean; held?: number; strike?: number }) {
  return {
    account: { findUnique: async () => ({ userId: "u1" }) },
    user: { findUnique: async () => ({ isBot: options.isBot }) },
    futuresPosition: {
      // 옵션은 순포지션(NET) 행 하나 — 다른 키로 찾으면 행이 없다.
      findUnique: async ({ where }: any) =>
        where?.accountId_symbol_positionSide?.positionSide === "NET" && options.held != null ? { qty: options.held } : null,
    },
    order: { findMany: async () => [] },
    optionSeries: { findUnique: async () => ({ strike: options.strike ?? 10_000 }) },
  };
}

describe("option order holds", () => {
  it("index option buy holds the premium: price × 100원", async () => {
    // 4.50pt = 450단위 × 100원 = 45,000원/계약
    await expect(optionOrderHoldPerUnit(fakeDb({ isBot: false }), "a", optionDef("KC11")!, "BUY", 2, 450)).resolves.toBe(45_000n);
  });

  it("index option writer margin for the market maker: strike notional × 8%", async () => {
    // 917.50pt × 100원 × 8% = 734,000원/계약
    await expect(
      optionOrderHoldPerUnit(fakeDb({ isBot: true, strike: 91_750 }), "a", optionDef("KP21")!, "SELL", 1, 40),
    ).resolves.toBe(734_000n);
  });

  it("retired KCOM options: users cannot buy, can still sell what they hold", async () => {
    const kcom = optionDef("KCOMC3")!;
    await expect(optionOrderHoldPerUnit(fakeDb({ isBot: false }), "a", kcom, "BUY", 1, 44)).rejects.toThrow(/거래가 끝난 옵션/);
    await expect(optionOrderHoldPerUnit(fakeDb({ isBot: false, held: 3 }), "a", kcom, "SELL", 3, 44)).resolves.toBe(0n);
  });

  it("retired KCOM options: the market maker may bid (holders can exit) but not write", async () => {
    const kcom = optionDef("KCOMC3")!;
    await expect(optionOrderHoldPerUnit(fakeDb({ isBot: true }), "a", kcom, "BUY", 1, 44)).resolves.toBe(44_000n);
    await expect(optionOrderHoldPerUnit(fakeDb({ isBot: true, held: 0 }), "a", kcom, "SELL", 1, 44)).rejects.toThrow(/새로 쓸 수 없습니다/);
  });
});
