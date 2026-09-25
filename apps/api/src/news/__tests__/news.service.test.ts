import { describe, expect, it, vi } from "vitest";
import { NewsService } from "../news.service";

function serviceWith(rows: unknown[], redis = { publish: vi.fn().mockResolvedValue(1) }) {
  const prisma = {
    newsItem: {
      findMany: vi.fn().mockResolvedValue(rows),
      upsert: vi.fn().mockResolvedValue(rows[0]),
    },
    marketSymbol: { findUnique: vi.fn().mockResolvedValue({ lastPrice: 121_700 }) },
  };
  return { service: new NewsService(prisma as never, redis as never), prisma, redis };
}

const ROW = {
  id: "row-1",
  symbol: "KABU",
  category: "CAPITAL",
  headline: "카부증권, 3,200억원 규모 자사주 취득 신탁계약 체결",
  body: null,
  createdAt: new Date("2026-09-08T10:42:00.000Z"),
};

describe("NewsService.list", () => {
  it("never exposes the sentiment or impact the price model was driven with", async () => {
    const { service } = serviceWith([ROW]);
    const [item] = await service.list(undefined, 10);

    expect(item).toEqual({
      id: "row-1",
      symbol: "KABU",
      symbolName: "카부증권",
      category: "CAPITAL",
      headline: ROW.headline,
      body: null,
      ts: Date.parse("2026-09-08T10:42:00.000Z"),
    });
    expect(Object.keys(item)).not.toContain("sentiment");
    expect(Object.keys(item)).not.toContain("impact");
  });

  it("does not even select the hidden columns from the database", async () => {
    const { service, prisma } = serviceWith([ROW]);
    await service.list("KABU", 10);

    const select = prisma.newsItem.findMany.mock.calls[0][0].select;
    expect(select.sentiment).toBeUndefined();
    expect(select.impact).toBeUndefined();
  });

  it("includes market-wide stories in a single symbol's feed", async () => {
    const { service, prisma } = serviceWith([ROW]);
    await service.list("KABU", 10);

    expect(prisma.newsItem.findMany.mock.calls[0][0].where).toEqual({
      OR: [{ symbol: "KABU" }, { symbol: null }],
    });
  });

  it("serves an industry feed without market-wide stories, and a market-only feed", async () => {
    const { service, prisma } = serviceWith([ROW]);
    await service.list(undefined, 10, ["MOCK", "DAON"]);
    await service.list(undefined, 10, null);

    expect(prisma.newsItem.findMany.mock.calls[0][0].where).toEqual({ symbol: { in: ["MOCK", "DAON"] } });
    expect(prisma.newsItem.findMany.mock.calls[1][0].where).toEqual({ symbol: null });
  });

  it("caps the page size so one request cannot pull the whole table", async () => {
    const { service, prisma } = serviceWith([ROW]);
    await service.list(undefined, 10_000);
    expect(prisma.newsItem.findMany.mock.calls[0][0].take).toBe(100);
  });
});

describe("NewsService.publish", () => {
  const draft = {
    externalId: "12:cap.buyback",
    parentExternalId: null,
    symbol: "KABU",
    category: "CAPITAL",
    headline: ROW.headline,
    body: null,
    sentiment: "POSITIVE",
    impact: 42,
  };

  it("rejects a caller without the bootstrap token", async () => {
    const { service } = serviceWith([ROW]);
    await expect(service.publish("wrong-token", draft)).rejects.toThrow(/token/i);
  });

  it("broadcasts only the public projection", async () => {
    const { service, redis } = serviceWith([ROW]);
    await service.publish(process.env.LIQUIDITY_BOOTSTRAP_TOKEN, draft).catch(() => {});

    for (const [, payload] of redis.publish.mock.calls) {
      expect(payload).not.toContain("sentiment");
      expect(payload).not.toContain("impact");
    }
  });
});
