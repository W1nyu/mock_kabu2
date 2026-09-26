import { futuresTradingDay, nextFuturesSettlementAt } from "@mock-kabu/shared";
import { describe, expect, it, vi } from "vitest";
import { OptionsService } from "../options.service";

const NOW = Date.parse("2026-09-26T08:00:00Z");
const DAY = futuresTradingDay(nextFuturesSettlementAt(NOW));

function harness(rows: { symbol: string; strike: number; tradingDay: string }[]) {
  const created: { symbol: string; strike: number }[] = [];
  const upserts: string[] = [];
  const prisma = {
    optionSeries: {
      findMany: vi.fn(async () => rows),
      create: vi.fn(async ({ data }: any) => created.push({ symbol: data.symbol, strike: data.strike })),
      upsert: vi.fn(async ({ where }: any) => upserts.push(where.symbol)),
    },
    marketSymbol: { update: vi.fn(async () => undefined) },
  };
  // KCOM 기초자산 = 5종 평균 100.50pt, 원/달러 1,405.0원
  const prices = new Map([
    ["OILF", 10_050],
    ["GASF", 10_050],
    ["CPRF", 10_050],
    ["GOLDF", 10_050],
    ["CORNF", 10_050],
    ["USDF", 14_050],
  ]);
  const futures = { underlyingUnits: vi.fn(async () => prices) };
  const service = new OptionsService(prisma as never, futures as never);
  return { service, created, upserts };
}

describe("OptionsService.ensureSeries", () => {
  it("widening 5 → 11 strikes mid-day keeps today's strikes and adds new ones outside them", async () => {
    const today = [9_950, 10_000, 10_050, 10_100, 10_150];
    const rows = [
      ...today.flatMap((strike, index) => [
        { symbol: `KCOMC${index + 1}`, strike, tradingDay: DAY },
        { symbol: `KCOMP${index + 1}`, strike, tradingDay: DAY },
      ]),
      // 원/달러는 이미 11개가 다 있다
      ...Array.from({ length: 11 }, (_, index) => [
        { symbol: `UC${index + 1}`, strike: 13_800 + index * 50, tradingDay: DAY },
        { symbol: `UP${index + 1}`, strike: 13_800 + index * 50, tradingDay: DAY },
      ]).flat(),
    ];
    const h = harness(rows);
    await h.service.ensureSeries(NOW);

    expect(h.upserts).toEqual([]); // 기존 행사가는 건드리지 않는다
    expect(h.created).toHaveLength(12); // KCOM 콜·풋 6..11
    const strikes = [...new Set(h.created.map((row) => row.strike))].sort((a, b) => a - b);
    expect(strikes).toEqual([9_800, 9_850, 9_900, 10_200, 10_250, 10_300]);
    // 같은 자리의 콜·풋은 같은 행사가
    for (let slot = 6; slot <= 11; slot++) {
      const call = h.created.find((row) => row.symbol === `KCOMC${slot}`)!;
      const put = h.created.find((row) => row.symbol === `KCOMP${slot}`)!;
      expect(call.strike).toBe(put.strike);
    }
  });

  it("lays out a fresh 11-strike ladder around the money when the family has nothing for today", async () => {
    const h = harness([{ symbol: "KCOMC1", strike: 9_000, tradingDay: "2026-01-01" }]);
    await h.service.ensureSeries(NOW);
    expect(h.created).toEqual([]);
    // KCOM 22종목 + 원/달러 22종목을 모두 다시 깐다(정상 배치)
    expect(h.upserts).toHaveLength(44);
  });
});
