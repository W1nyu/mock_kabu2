import { describe, expect, it, vi } from "vitest";
import { liquidityBootstrapToken } from "../../liquidity/liquidity-reserve";
import { ReferenceService } from "../reference.service";

function serviceWith() {
  const pipeline = { set: vi.fn(), publish: vi.fn(), exec: vi.fn().mockResolvedValue([]) };
  const redis = { pipeline: vi.fn(() => pipeline), mget: vi.fn() };
  const prisma = { $executeRaw: vi.fn().mockResolvedValue(1), $queryRaw: vi.fn().mockResolvedValue([]) };
  return { service: new ReferenceService(prisma as never, redis as never), prisma, redis, pipeline };
}

describe("ReferenceService.publish", () => {
  const token = () => liquidityBootstrapToken();

  it("stores the latest value, broadcasts it, and folds it into the minute candle", async () => {
    const { service, prisma, pipeline } = serviceWith();
    const ts = Date.now();
    const result = await service.publish(token(), { ts, prices: { USDKRW: 14_005, OIL: 10_123 } });

    expect(result).toEqual({ accepted: 2 });
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const sql = (prisma.$executeRaw.mock.calls[0][0] as TemplateStringsArray).join("?");
    expect(sql).toContain("ON CONFLICT (code, interval, ts) DO UPDATE");
    expect(sql).toContain("GREATEST");
    expect(pipeline.set).toHaveBeenCalledTimes(2);
    expect(pipeline.publish.mock.calls.map(([channel]) => String(channel))).toEqual([
      expect.stringMatching(/ref:USDKRW$/),
      expect.stringMatching(/ref:OIL$/),
    ]);
    expect(JSON.parse(pipeline.publish.mock.calls[0][1])).toEqual({ code: "USDKRW", value: 14_005, ts });
  });

  it("rejects a caller without the token, unknown assets, bad values and stale timestamps", async () => {
    const { service, prisma } = serviceWith();
    const now = Date.now();
    await expect(service.publish("nope", { ts: now, prices: { OIL: 1 } })).rejects.toThrow(/token/);
    await expect(service.publish(token(), { ts: now, prices: { SILVER: 1 } })).rejects.toThrow(/unknown/);
    await expect(service.publish(token(), { ts: now, prices: { OIL: 10.5 } })).rejects.toThrow(/invalid/);
    await expect(service.publish(token(), { ts: now, prices: { OIL: -1 } })).rejects.toThrow(/invalid/);
    await expect(service.publish(token(), { ts: now - 5 * 60_000, prices: { OIL: 1 } })).rejects.toThrow(/ts/);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });
});

describe("ReferenceService.candles", () => {
  it("refuses unknown assets and intervals", async () => {
    const { service } = serviceWith();
    await expect(service.candles("SILVER", "1m", 10)).rejects.toThrow(/기초자산/);
    await expect(service.candles("OIL", "7m", 10)).rejects.toThrow(/봉 간격/);
  });
});
