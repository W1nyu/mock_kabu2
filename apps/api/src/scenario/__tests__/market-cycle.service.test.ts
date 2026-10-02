import { describe, expect, it, vi } from "vitest";
import { liquidityBootstrapToken } from "../../liquidity/liquidity-reserve";
import { MarketCycleService, parseMarketCycleReport } from "../market-cycle.service";

const NOW = Date.parse("2026-10-02T09:00:00Z");

function report(overrides: Record<string, unknown> = {}) {
  const driver = { phase: "STEADY", sinceMs: NOW - 3_600_000, lean: 0.02 };
  return {
    reportedAtMs: NOW,
    market: { phase: "BEAR", sinceMs: NOW - 7_200_000, cycleLean: -0.42, lean: -0.5, positiveShare: 0.34 },
    drivers: { RATE: { ...driver, phase: "RISING", lean: 0.7 }, FX: driver, OIL: driver, COMMODITY: driver },
    valuation: { index: 1_110.4, fairIndex: 1_010.1, pull: -0.08 },
    ...overrides,
  };
}

function setup(isAdmin: boolean) {
  const prisma = { user: { findUnique: vi.fn().mockResolvedValue({ isAdmin }) } };
  return { service: new MarketCycleService(prisma as never), prisma };
}

describe("automatic market cycle report", () => {
  it("accepts a bot report only with the internal token", () => {
    const { service } = setup(true);
    expect(() => service.receive("wrong-token", report())).toThrow();
    expect(service.receive(liquidityBootstrapToken(), report())).toEqual({ ok: true });
  });

  it("shows the latest report to the admin and hides the feature from everyone else", async () => {
    const admin = setup(true);
    await expect(admin.service.current("admin-id")).resolves.toEqual({ report: null });
    admin.service.receive(liquidityBootstrapToken(), report());
    const { report: latest } = await admin.service.current("admin-id");
    expect(latest?.market.phase).toBe("BEAR");
    expect(latest?.drivers.RATE.phase).toBe("RISING");

    const user = setup(false);
    user.service.receive(liquidityBootstrapToken(), report());
    await expect(user.service.current("user-1")).rejects.toMatchObject({ status: 404 });
  });

  it("rejects malformed reports and drops fields it does not know", () => {
    expect(() => parseMarketCycleReport(report({ market: { phase: "MOON" } }))).toThrow();
    expect(() => parseMarketCycleReport(report({ drivers: {} }))).toThrow();
    expect(() =>
      parseMarketCycleReport(report({ valuation: { index: null, fairIndex: 1_000, pull: 5 } })),
    ).toThrow();
    const parsed = parseMarketCycleReport({ ...report(), nextPhaseAt: NOW + 1 });
    expect(parsed).not.toHaveProperty("nextPhaseAt");
    expect(parseMarketCycleReport(report({ valuation: { index: null, fairIndex: 1_000, pull: 0 } })).valuation.index).toBeNull();
  });
});
