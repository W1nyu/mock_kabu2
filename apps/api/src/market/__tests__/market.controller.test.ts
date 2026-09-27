import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoCache } from "../../core/memo-cache";
import { mapWithConcurrency } from "../../common/map-with-concurrency";
import { MarketController, mergeSessionStats } from "../market.controller";
import { SYMBOLS } from "@mock-kabu/shared";

afterEach(() => vi.useRealTimers());

describe("market session reference", () => {
  it("uses the first trade after 09:00 KST, falling back to the prior close until then", async () => {
    let firstTradeAvailable = false;
    const query = vi.fn(async (strings: TemplateStringsArray, ...params: unknown[]) => {
      const sql = strings.join("?");
      if (sql.includes("FROM market.symbols s")) {
        expect(sql).toContain("COALESCE(opening.price, previous.price, s.initial_price)");
        expect(sql).toContain("t.created_at >= ? AND t.created_at < ?");
        expect(sql).toContain("ORDER BY t.created_at ASC, t.id ASC LIMIT 1");
        expect(sql).toContain("t.created_at < ?");
        // 재상장 전 체결은 기준가 계산에서 빠진다.
        expect(sql).toContain("AND t.created_at >= ?");
        const [session, next, before] = params.filter((value) => value instanceof Date) as Date[];
        expect(next).toEqual(new Date(session.getTime() + 24 * 60 * 60 * 1000));
        expect(before).toEqual(session);
        return [{
          symbol: "KABU", name: "카부증권", initialPrice: 1000, tickSize: 10,
          lastPrice: 1300, referencePrice: session.getUTCDate() === 22 ? 1200 : firstTradeAvailable ? 1250 : 1300,
        }];
      }
      const session = params.find((value) => value instanceof Date) as Date;
      const stats = {
        high: session.getUTCDate() === 22 ? 1300 : null,
        low: session.getUTCDate() === 22 ? 1200 : null,
        volume: session.getUTCDate() === 22 ? 10n : 0n,
        turnover: 0n, buy_volume: 0n, sell_volume: 0n, last_trade_ts: null,
      };
      if (!sql.includes("GROUP BY t.symbol")) return [stats];
      // overview는 5분 경계까지(until 있음)와 그 뒤를 나눠 합산한다 — 이 시나리오의 체결은 모두 경계 전.
      const hasUntil = params.some((value: any) => Array.isArray(value?.values) && value.values.some((v: unknown) => v instanceof Date));
      return hasUntil ? [{ symbol: "KABU", ...stats }] : [];
    });
    const controller = new MarketController({ $queryRaw: query } as any, {} as any, new MemoCache());

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T23:59:59.900Z"));
    expect((await controller.overview())[0]).toMatchObject({ referencePrice: 1200, volume: 10 });

    vi.setSystemTime(new Date("2026-09-23T00:00:00.100Z"));
    expect((await controller.symbols())[0].referencePrice).toBe(1300);
    expect((await controller.overview())[0]).toMatchObject({ referencePrice: 1300, sessionStart: Date.parse("2026-09-23T00:00:00Z"), volume: 0 });
    expect(await controller.summary("KABU")).toMatchObject({ referencePrice: 1300, volume: 0 });

    firstTradeAvailable = true;
    vi.setSystemTime(new Date("2026-09-23T00:00:03.200Z"));
    // 만료 직후 첫 요청은 이전 값을 바로 받고(stale-while-revalidate) 갱신은 뒤에서 돈다 — 곧 새 기준가로 바뀐다.
    await vi.waitFor(async () => expect((await controller.symbols())[0].referencePrice).toBe(1250));
    await vi.waitFor(async () => expect((await controller.overview())[0].referencePrice).toBe(1250));
    await vi.waitFor(async () => expect(await controller.summary("KABU")).toMatchObject({ referencePrice: 1250 }));
  });
});

describe("market index session level", () => {
  it("carries pre-range prices and keeps the 09:00 opening level instead of resetting to 1,000", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-24T00:02:00Z"));
    const open = new Date("2026-09-24T00:00:00Z");
    const query = vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join("?");
      if (sql.includes("SELECT s.symbol")) return SYMBOLS.map(({ symbol }) => ({ symbol, close: 900 }));
      expect(sql).toContain("FIRST_VALUE(open) OVER (PARTITION BY bucket, symbol ORDER BY ts ASC)");
      return [
        { bucket: open, symbol: SYMBOLS[0].symbol, open: 920, close: 930 },
        { bucket: new Date(open.getTime() + 60_000), symbol: SYMBOLS[0].symbol, open: 930, close: 940 },
      ];
    });
    // 발행주식수가 같으면 시가총액 가중 지수는 동일가중과 같은 값이 된다.
    const controller = new MarketController({
      marketSymbol: { findMany: vi.fn(async () => SYMBOLS.map(({ symbol }) => ({ symbol, initialPrice: 1000, listedShares: 1n }))) },
      indexEpoch: {
        findMany: vi.fn(async () => [{ startsAt: new Date(0), divisor: SYMBOLS.length, members: SYMBOLS.map((s) => s.symbol) }]),
      },
      $queryRaw: query,
    } as any, {} as any, new MemoCache());

    // 첫 종목만 920(09:00 시가) → 940, 나머지는 직전 종가 900을 이어받는다.
    const n = SYMBOLS.length;
    const expected = [
      { ts: open.getTime(), value: Math.round(((920 + 900 * (n - 1)) / n) * 100) / 100 },
      { ts: open.getTime() + 60_000, value: Math.round(((940 + 900 * (n - 1)) / n) * 100) / 100 },
    ];
    expect(await controller.marketIndex("1d")).toEqual(expected);
    expect(await controller.marketIndex("1w")).toEqual(expected);
    expect(query).toHaveBeenCalledTimes(4);
  });
});

describe("market-cap index across a relisting", () => {
  it("excludes the relisted symbol before its epoch and weights by listed shares after it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-24T01:05:00Z"));
    const t0 = new Date("2026-09-24T01:00:00Z");
    const relistAt = new Date(t0.getTime() + 60_000);
    const [a, b] = ["AAA", "BBB"];
    const query = vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join("?");
      if (sql.includes("SELECT s.symbol")) return [{ symbol: a, close: 100 }, { symbol: b, close: null }];
      return [
        { bucket: t0, symbol: a, open: 100, close: 110 },
        { bucket: relistAt, symbol: b, open: 50, close: 60 },
      ];
    });
    const controller = new MarketController({
      marketSymbol: {
        findMany: vi.fn(async () => [
          { symbol: a, initialPrice: 100, listedShares: 10n },
          { symbol: b, initialPrice: 50, listedShares: 20n },
        ]),
      },
      indexEpoch: {
        findMany: vi.fn(async () => [
          // 재상장 전: AAA만, 상장 시 1,000
          { startsAt: new Date(0), divisor: (100 * 10) / 1000, members: [a] },
          // 재상장 시각: AAA 110 × 10 + BBB 50 × 20 = 2,100을 직전 수준 1,100으로 잇는다
          { startsAt: relistAt, divisor: 2100 / 1100, members: [a, b] },
        ]),
      },
      $queryRaw: query,
    } as any, {} as any, new MemoCache());

    const [before, after] = await controller.marketIndex("1d");
    expect(before).toEqual({ ts: t0.getTime(), value: 1100 });
    // BBB 50 → 60 (+20%), 비중 1000/2100 → 지수 1100 × (1 + 0.2 × 1000/2100)
    expect(after.ts).toBe(relistAt.getTime());
    expect(after.value).toBeCloseTo((110 * 10 + 60 * 20) / (2100 / 1100), 2);
  });
});

describe("aggregated candles past the 1m retention window", () => {
  const sourceIntervals = async (interval: string) => {
    const query = vi.fn(async () => []);
    const controller = new MarketController({ $queryRaw: query } as any, {} as any, new MemoCache());
    await controller.candles("KABU", interval);
    const fragments = (query.mock.calls[0] as unknown[]).slice(1).filter((value): value is { values: unknown[] } =>
      typeof value === "object" && value !== null && "values" in value,
    );
    return fragments.flatMap((fragment) => fragment.values);
  };

  it("reads the 1h rollups for 1h/4h/1d buckets but not for sub-hour ones", async () => {
    expect(await sourceIntervals("1d")).toEqual(["1m", "1h"]);
    expect(await sourceIntervals("4h")).toEqual(["1m", "1h"]);
    expect(await sourceIntervals("1h")).toEqual(["1m", "1h"]);
    expect(await sourceIntervals("15m")).toEqual(["1m"]);
    expect(await sourceIntervals("5m")).toEqual(["1m"]);
  });
});

describe("latest trades for every symbol in one request", () => {
  it("returns newest-first trades keyed by symbol, respecting relisting, and shares the result briefly", async () => {
    const query = vi.fn(async (strings: TemplateStringsArray, ...params: unknown[]) => {
      const sql = strings.join("?");
      // 한 쿼리로 종목별 최신 N건 — 재상장 전 체결은 빼고, 최신순.
      expect(sql).toContain("LEFT JOIN LATERAL");
      expect(sql).toContain("t.created_at >= ?");
      expect(sql).toContain("ORDER BY t.created_at DESC");
      expect(params).toContain(5);
      return [
        { listedSymbol: "KABU", id: "KABU-2", price: 101 },
        { listedSymbol: "KABU", id: "KABU-1", price: 100 },
        // 체결이 없는 종목은 LEFT JOIN으로 id가 null인 한 행만 온다.
        { listedSymbol: "MOCK", id: null, price: null },
      ];
    });
    const controller = new MarketController({ $queryRaw: query } as any, {} as any, new MemoCache());

    const first = await controller.latestTrades("5");
    expect(first).toEqual({ KABU: [{ id: "KABU-2", price: 101 }, { id: "KABU-1", price: 100 }], MOCK: [] });

    await controller.latestTrades("5");
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe("mergeSessionStats", () => {
  it("adds volumes, keeps extremes and the latest trade across the base and recent parts", () => {
    const row = (high: number | null, low: number | null, volume: bigint, ts: string | null) => ({
      symbol: "KABU", high, low, volume, turnover: volume * 100n, buy_volume: volume, sell_volume: 0n,
      last_trade_ts: ts ? new Date(ts) : null,
    });
    const merged = mergeSessionStats(
      [row(1300, 1200, 10n, "2026-09-23T00:04:00Z"), { ...row(500, 400, 1n, null), symbol: "NEKO" }],
      [row(1350, 1250, 5n, "2026-09-23T00:06:00Z")],
    );
    expect(merged.get("KABU")).toMatchObject({ high: 1350, low: 1200, volume: 15n, turnover: 1500n, buy_volume: 15n });
    expect(merged.get("KABU")?.last_trade_ts).toEqual(new Date("2026-09-23T00:06:00Z"));
    expect(merged.get("NEKO")).toMatchObject({ high: 500, volume: 1n });
  });
});

describe("mapWithConcurrency", () => {
  it("keeps order and never runs more than the limit at once", async () => {
    let running = 0;
    let peak = 0;
    const out = await mapWithConcurrency([5, 1, 4, 2, 3, 0], 2, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, n));
      running--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30, 0]);
    expect(peak).toBe(2);
  });
});
