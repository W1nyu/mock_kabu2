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
  // 주가지수 916.40pt, 원/달러 1,405.0원
  const prices = new Map([
    ["KABUF", 91_640],
    ["USDF", 14_050],
  ]);
  const futures = { underlyingUnits: vi.fn(async () => prices) };
  const service = new OptionsService(prisma as never, futures as never);
  return { service, created, upserts };
}

describe("OptionsService.ensureSeries", () => {
  it("widening 11 → 21 strikes mid-day keeps today's strikes and adds new ones outside them", async () => {
    const today = Array.from({ length: 11 }, (_, index) => 90_500 + index * 250);
    const rows = [
      ...today.flatMap((strike, index) => [
        { symbol: `KC${index + 1}`, strike, tradingDay: DAY },
        { symbol: `KP${index + 1}`, strike, tradingDay: DAY },
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
    expect(h.created).toHaveLength(20); // 주가지수 콜·풋 12..21
    const strikes = [...new Set(h.created.map((row) => row.strike))].sort((a, b) => a - b);
    expect(strikes).toEqual([89_250, 89_500, 89_750, 90_000, 90_250, 93_250, 93_500, 93_750, 94_000, 94_250]);
    // 같은 자리의 콜·풋은 같은 행사가
    for (let slot = 12; slot <= 21; slot++) {
      const call = h.created.find((row) => row.symbol === `KC${slot}`)!;
      const put = h.created.find((row) => row.symbol === `KP${slot}`)!;
      expect(call.strike).toBe(put.strike);
    }
  });

  it("reopening the index options lays a fresh 21-strike ladder even though yesterday's KC1..KP5 rows remain", async () => {
    const stale = [1, 2, 3, 4, 5].flatMap((slot) => [
      { symbol: `KC${slot}`, strike: 86_000 + slot * 1_000, tradingDay: "2026-09-26" },
      { symbol: `KP${slot}`, strike: 86_000 + slot * 1_000, tradingDay: "2026-09-26" },
    ]);
    const current = Array.from({ length: 11 }, (_, index) => [
      { symbol: `UC${index + 1}`, strike: 13_800 + index * 50, tradingDay: DAY },
      { symbol: `UP${index + 1}`, strike: 13_800 + index * 50, tradingDay: DAY },
    ]).flat();
    const h = harness([...stale, ...current]);
    await h.service.ensureSeries(NOW);
    expect(h.created).toEqual([]);
    // 주가지수 42종목만 정상 배치로 다시 깐다(원/달러는 그대로)
    expect(h.upserts).toHaveLength(42);
    expect(h.upserts.every((symbol) => /^K[CP]\d+$/.test(symbol))).toBe(true);
  });

  it("lays out fresh ladders for every live family when nothing is set for today", async () => {
    const h = harness([{ symbol: "KC1", strike: 9_000, tradingDay: "2026-01-01" }]);
    await h.service.ensureSeries(NOW);
    expect(h.created).toEqual([]);
    // 주가지수 42종목 + 원/달러 22종목(거래 종료한 KCOM은 깔지 않는다)
    expect(h.upserts).toHaveLength(64);
    expect(h.upserts.some((symbol) => symbol.startsWith("KCOM"))).toBe(false);
  });
});
