import { describe, expect, it, vi } from "vitest";
import { industryById } from "@mock-kabu/shared";
import { liquidityBootstrapToken } from "../../liquidity/liquidity-reserve";
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
  industry: null,
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
      industry: null,
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

  it("includes market-wide stories and its own industry's stories in a single symbol's feed", async () => {
    const { service, prisma } = serviceWith([ROW]);
    await service.list("KABU", 10);

    expect(prisma.newsItem.findMany.mock.calls[0][0].where).toEqual({
      OR: [{ symbol: "KABU" }, { symbol: null, industry: null }, { industry: "finance" }],
    });
  });

  it("serves an industry feed (its symbols + industry stories) and a market-only feed", async () => {
    const { service, prisma } = serviceWith([ROW]);
    await service.list(undefined, 10, industryById("tech"));
    await service.list(undefined, 10, null);

    expect(prisma.newsItem.findMany.mock.calls[0][0].where).toEqual({
      OR: [{ symbol: { in: ["DAON"] } }, { industry: "tech" }],
    });
    expect(prisma.newsItem.findMany.mock.calls[1][0].where).toEqual({ symbol: null, industry: null });
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
    await service.publish(liquidityBootstrapToken(), draft);
    expect(redis.publish).toHaveBeenCalled();

    for (const [, payload] of redis.publish.mock.calls) {
      expect(payload).not.toContain("sentiment");
      expect(payload).not.toContain("impact");
    }
  });

  it("routes an industry story to that industry's symbols and the firehose only", async () => {
    const industryRow = { ...ROW, id: "row-2", symbol: null, industry: "tech", category: "SECTOR" };
    const { service, redis } = serviceWith([industryRow]);
    await service.publish(liquidityBootstrapToken(), {
      ...draft,
      externalId: "13:sec.semi.export.up",
      symbol: null,
      industry: "tech",
      category: "SECTOR",
    });

    const channels = redis.publish.mock.calls.map(([channel]) => String(channel));
    // IT·반도체는 상장 폐지된 MOCK이 빠져 DAON만 남는다 → DAON 채널 + 전체 피드
    expect(channels.some((channel) => channel.endsWith("MOCK"))).toBe(false);
    expect(channels.some((channel) => channel.endsWith("DAON"))).toBe(true);
    expect(channels.some((channel) => channel.endsWith("KABU"))).toBe(false);
    expect(channels).toHaveLength(2);
  });

  it("rejects an unknown industry, or an industry on a company story", async () => {
    const { service } = serviceWith([ROW]);
    const token = liquidityBootstrapToken();
    await expect(service.publish(token, { ...draft, symbol: null, industry: "nope" })).rejects.toThrow(/industry/);
    await expect(service.publish(token, { ...draft, industry: "tech" })).rejects.toThrow(/industry/);
  });
});
