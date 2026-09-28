import { futuresTradingDay, inOptionsRestrikeGap, nextFuturesSettlementAt, nextOptionsRestrikeAt, optionFamily, OPTIONS } from "@mock-kabu/shared";
import { describe, expect, it, vi } from "vitest";
import { isContiguousLadder, OptionsService } from "../options.service";

const NOW = Date.parse("2026-09-26T08:00:00Z"); // 17:00 KST
const DAY = futuresTradingDay(nextFuturesSettlementAt(NOW));

type Row = { symbol: string; strike: number; tradingDay: string };

function harness(rows: Row[], busy: { positions?: number; orders?: number } = {}) {
  const created: { symbol: string; strike: number }[] = [];
  const upserts: { symbol: string; strike: number }[] = [];
  const prisma = {
    optionSeries: {
      findMany: vi.fn(async () => rows),
      create: vi.fn(async ({ data }: any) => created.push({ symbol: data.symbol, strike: data.strike })),
      upsert: vi.fn(async ({ where, update }: any) => upserts.push({ symbol: where.symbol, strike: update.strike })),
    },
    marketSymbol: { update: vi.fn(async () => undefined), updateMany: vi.fn(async () => ({ count: 1 })) },
    futuresPosition: { count: vi.fn(async () => busy.positions ?? 0) },
    order: { count: vi.fn(async () => busy.orders ?? 0) },
  };
  // 주가지수 1,105.78pt, 원/달러 1,405.0원
  const prices = new Map([
    ["KABUF", 110_578],
    ["USDF", 14_050],
  ]);
  const futures = { underlyingUnits: vi.fn(async () => prices) };
  const service = new OptionsService(prisma as never, futures as never);
  return { service, created, upserts, prisma };
}

/** 원/달러는 오늘 11개가 다 있다 */
const USD_TODAY: Row[] = Array.from({ length: 11 }, (_, index) => [
  { symbol: `UC${index + 1}`, strike: 13_800 + index * 50, tradingDay: DAY },
  { symbol: `UP${index + 1}`, strike: 13_800 + index * 50, tradingDay: DAY },
]).flat();

function indexLadder(strikeOf: (slot: number) => number, slots = 21, day = DAY): Row[] {
  return Array.from({ length: slots }, (_, index) => [
    { symbol: `KC${index + 1}`, strike: strikeOf(index + 1), tradingDay: day },
    { symbol: `KP${index + 1}`, strike: strikeOf(index + 1), tradingDay: day },
  ]).flat();
}

describe("OptionsService.ensureSeries", () => {
  it("lays 21 index strikes 5pt apart: 10 below and 10 above the at-the-money strike", async () => {
    const stale = indexLadder((slot) => 86_000 + slot * 1_000, 5, "2026-09-26");
    const h = harness([...stale, ...USD_TODAY]);
    await h.service.ensureSeries(NOW);
    expect(h.created).toEqual([]);
    expect(h.upserts).toHaveLength(42); // 주가지수만(원/달러는 그대로)
    const strikes = [...new Set(h.upserts.map((row) => row.strike))].sort((a, b) => a - b);
    expect(strikes).toHaveLength(21);
    const atm = 110_500; // 1,105.78pt → 5pt 격자에서 가장 가까운 1,105.00
    expect(strikes.filter((strike) => strike < atm)).toHaveLength(10);
    expect(strikes.filter((strike) => strike > atm)).toHaveLength(10);
    expect(strikes[0]).toBe(105_500);
    expect(strikes[20]).toBe(115_500);
    expect(h.upserts.find((row) => row.symbol === "KC11")!.strike).toBe(atm);
    expect(h.upserts.find((row) => row.symbol === "KP11")!.strike).toBe(atm);
  });

  it("re-lays a broken ladder (half-laid, mixed days, wrong step) when nobody holds or quotes it", async () => {
    // 오늘 KC1~6만 2.5pt 간격, 나머지는 예전 거래일 — 2026-09-29 배포 중 seed 전 기동으로 생긴 상태
    const rows = [
      ...indexLadder((slot) => 108_000 + (slot - 1) * 250, 6).filter((row) => row.symbol.startsWith("KC")),
      ...indexLadder((slot) => 86_000 + slot * 1_000, 5, "2026-09-26").filter((row) => row.symbol.startsWith("KP")),
      ...USD_TODAY,
    ];
    const h = harness(rows);
    await h.service.ensureSeries(NOW);
    expect(h.created).toEqual([]);
    expect(h.upserts).toHaveLength(42);
    expect(new Set(h.upserts.map((row) => row.strike)).size).toBe(21);
  });

  it("leaves a broken ladder alone while positions or live orders sit on it", async () => {
    const rows = [...indexLadder((slot) => 108_000 + (slot - 1) * 250), ...USD_TODAY];
    for (const busy of [{ positions: 1 }, { orders: 2 }]) {
      const h = harness(rows, busy);
      await h.service.ensureSeries(NOW);
      expect(h.upserts).toEqual([]);
      expect(h.created).toEqual([]);
    }
  });

  it("widening mid-day keeps today's strikes and adds new ones outside them", async () => {
    const rows = [...indexLadder((slot) => 108_000 + (slot - 1) * 500, 11), ...USD_TODAY];
    const h = harness(rows, { positions: 3 });
    await h.service.ensureSeries(NOW);
    expect(h.upserts).toEqual([]); // 기존 행사가는 건드리지 않는다
    expect(h.created).toHaveLength(20); // 주가지수 콜·풋 12..21
    const strikes = [...new Set(h.created.map((row) => row.strike))].sort((a, b) => a - b);
    expect(strikes).toEqual([105_500, 106_000, 106_500, 107_000, 107_500, 113_500, 114_000, 114_500, 115_000, 115_500]);
    for (let slot = 12; slot <= 21; slot++) {
      expect(h.created.find((row) => row.symbol === `KC${slot}`)!.strike).toBe(h.created.find((row) => row.symbol === `KP${slot}`)!.strike);
    }
  });

  it("lays fresh ladders for every live family when nothing is set for today (retired KCOM is skipped)", async () => {
    const h = harness([{ symbol: "KC1", strike: 9_000, tradingDay: "2026-01-01" }]);
    await h.service.ensureSeries(NOW);
    expect(h.created).toEqual([]);
    expect(h.upserts).toHaveLength(64);
    expect(h.upserts.some((row) => row.symbol.startsWith("KCOM"))).toBe(false);
  });

  it("does nothing between the 04:11 expiry and 04:20 — strikes follow the 04:20 underlying", async () => {
    const gap = Date.parse("2026-09-28T19:15:00Z"); // 04:15 KST
    expect(inOptionsRestrikeGap(gap)).toBe(true);
    const h = harness([]);
    await h.service.ensureSeries(gap);
    expect(h.prisma.optionSeries.findMany).not.toHaveBeenCalled();
    expect(h.upserts).toEqual([]);
    // 04:20 KST 뒤에는 다시 깐다
    const after = Date.parse("2026-09-28T19:20:30Z");
    expect(inOptionsRestrikeGap(after)).toBe(false);
    await h.service.ensureSeries(after);
    expect(h.upserts).toHaveLength(64);
  });
});

describe("option ladder helpers", () => {
  it("the daily restrike runs at 04:20 KST", () => {
    expect(new Date(nextOptionsRestrikeAt(Date.parse("2026-09-28T17:00:00Z"))).toISOString()).toBe("2026-09-28T19:20:00.000Z");
    expect(new Date(nextOptionsRestrikeAt(Date.parse("2026-09-28T19:20:00Z"))).toISOString()).toBe("2026-09-29T19:20:00.000Z");
    expect(inOptionsRestrikeGap(Date.parse("2026-09-28T19:10:59Z"))).toBe(false); // 04:10
  });

  it("a ladder is whole when today's strikes run one step apart with matching calls and puts", () => {
    const k = optionFamily("K")!;
    const series = OPTIONS.filter((o) => o.family.code === "K");
    const whole = new Map(indexLadder((slot) => 105_500 + (slot - 1) * 500).map((row) => [row.symbol, row]));
    expect(isContiguousLadder(k, series, whole, DAY)).toBe(true);
    const gap = new Map(whole);
    gap.set("KC21", { symbol: "KC21", strike: 120_000, tradingDay: DAY });
    gap.set("KP21", { symbol: "KP21", strike: 120_000, tradingDay: DAY });
    expect(isContiguousLadder(k, series, gap, DAY)).toBe(false);
    const mismatch = new Map(whole);
    mismatch.set("KP3", { symbol: "KP3", strike: 107_000, tradingDay: DAY });
    expect(isContiguousLadder(k, series, mismatch, DAY)).toBe(false);
    expect(isContiguousLadder(k, series, whole, "2026-09-28")).toBe(false);
  });
});
