import { optionDef } from "@mock-kabu/shared";
import { describe, expect, it } from "vitest";
import { optionOrderHoldPerUnit } from "../futures-margin";

/** 계좌·사용자·포지션·미체결·행사가만 흉내 낸 트랜잭션 */
function fakeDb(options: { isBot: boolean; held?: number; strike?: number }) {
  return {
    account: { findUnique: async () => ({ userId: "u1" }) },
    user: { findUnique: async () => ({ isBot: options.isBot }) },
    futuresPosition: { findUnique: async () => (options.held != null ? { qty: options.held } : null) },
    order: { findMany: async () => [] },
    optionSeries: { findUnique: async () => ({ strike: options.strike ?? 10_000 }) },
  };
}

describe("option order holds", () => {
  it("KCOM buy holds the premium: price × 1,000원", async () => {
    await expect(optionOrderHoldPerUnit(fakeDb({ isBot: false }), "a", optionDef("KCOMC3")!, "BUY", 2, 44)).resolves.toBe(44_000n);
  });

  it("KCOM writer margin for the market maker: strike notional × 4%", async () => {
    // 100.00pt × 1,000원 × 4% = 400,000원/계약
    await expect(
      optionOrderHoldPerUnit(fakeDb({ isBot: true, strike: 10_000 }), "a", optionDef("KCOMP3")!, "SELL", 1, 40),
    ).resolves.toBe(400_000n);
  });

  it("retired index options: users cannot buy, can still sell what they hold", async () => {
    const kc = optionDef("KC3")!;
    await expect(optionOrderHoldPerUnit(fakeDb({ isBot: false }), "a", kc, "BUY", 1, 450)).rejects.toThrow(/거래가 끝난 옵션/);
    await expect(optionOrderHoldPerUnit(fakeDb({ isBot: false, held: 3 }), "a", kc, "SELL", 3, 450)).resolves.toBe(0n);
  });

  it("retired index options: the market maker may bid (holders can exit) but not write", async () => {
    const kc = optionDef("KC3")!;
    await expect(optionOrderHoldPerUnit(fakeDb({ isBot: true }), "a", kc, "BUY", 1, 450)).resolves.toBe(45_000n);
    await expect(optionOrderHoldPerUnit(fakeDb({ isBot: true, held: 0 }), "a", kc, "SELL", 1, 450)).rejects.toThrow(/새로 쓸 수 없습니다/);
  });
});
