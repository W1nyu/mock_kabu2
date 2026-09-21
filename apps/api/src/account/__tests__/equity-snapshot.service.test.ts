import { describe, expect, it, vi } from "vitest";
import { EquitySnapshotService } from "../equity-snapshot.service";

function build(rows: unknown[]) {
  const prisma = { $queryRaw: vi.fn().mockResolvedValue(rows), $executeRaw: vi.fn().mockResolvedValue(3) };
  const service = new EquitySnapshotService(prisma as never);
  return { service, prisma };
}

describe("EquitySnapshotService.daily", () => {
  it("chains each day's change off the previous close and returns newest first", async () => {
    // DB는 최신순으로 돌려준다 (LIMIT days+1)
    const { service } = build([
      { day: new Date("2026-09-22T00:00:00Z"), close_equity: 10_500_000n, close_cash: 5_000_000n, realized: 20_000n, fills: 2n },
      { day: new Date("2026-09-21T00:00:00Z"), close_equity: 10_000_000n, close_cash: 4_000_000n, realized: 0n, fills: 0n },
      { day: new Date("2026-09-20T00:00:00Z"), close_equity: 9_800_000n, close_cash: 9_800_000n, realized: -5_000n, fills: 1n },
    ]);

    const rows = await service.daily("acct-1", 2);

    expect(rows.map((r) => r.date)).toEqual(["2026-09-22", "2026-09-21"]);
    expect(rows[0]).toMatchObject({ closeEquity: 10_500_000, change: 500_000, changeRate: 0.05, realized: 20_000, fills: 2 });
    // 9/21의 전일(9/20)은 표시 범위 밖이지만 LIMIT +1로 읽어 와 증감 계산에 쓴다.
    expect(rows[1]).toMatchObject({ closeEquity: 10_000_000, change: 200_000 });
  });

  it("leaves change undefined on a day with no snapshot and skips it as a base", async () => {
    const { service } = build([
      { day: new Date("2026-09-22T00:00:00Z"), close_equity: 11_000_000n, close_cash: 1n, realized: 0n, fills: 0n },
      { day: new Date("2026-09-21T00:00:00Z"), close_equity: null, close_cash: null, realized: 1_000n, fills: 1n },
      { day: new Date("2026-09-20T00:00:00Z"), close_equity: 10_000_000n, close_cash: 1n, realized: 0n, fills: 0n },
    ]);

    const rows = await service.daily("acct-1", 3);

    expect(rows[1]).toMatchObject({ date: "2026-09-21", closeEquity: null, change: null, realized: 1_000 });
    // 9/22의 전일 종가는 스냅샷이 있는 9/20으로 이어진다.
    expect(rows[0].change).toBe(1_000_000);
  });
});

describe("EquitySnapshotService.compact", () => {
  it("issues one delete per retention tier and sums the removed rows", async () => {
    const { service, prisma } = build([]);
    const removed = await service.compact();
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
    expect(removed).toBe(6);
  });
});
