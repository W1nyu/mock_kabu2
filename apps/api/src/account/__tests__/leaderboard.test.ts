import { describe, expect, it, vi } from "vitest";
import { MemoCache } from "../../core/memo-cache";
import { AccountService } from "../account.service";

const row = (accountId: string, equity: bigint, deposits: bigint) => ({
  account_id: accountId,
  nickname: accountId,
  equity,
  deposits,
  realized: 0n,
  joined_at: new Date("2026-09-20T00:00:00Z"),
  index_ratio: 1.1,
  index_current: 1100,
  index_base: 1000,
  base_equity: null,
  base_ts: null,
  period_flows: 0n,
});

describe("leaderboard", () => {
  it("turns JIT off for the ranking query in the same transaction and ranks by return", async () => {
    const calls: string[] = [];
    const prisma = {
      $executeRaw: vi.fn((strings: TemplateStringsArray) => {
        calls.push(strings.join("?").trim());
        return Promise.resolve(0);
      }),
      $queryRaw: vi.fn((strings: TemplateStringsArray) => {
        const sql = strings.join("?");
        calls.push("ranking");
        // 지수 기준 봉은 간격별로 기본키 역순 1건씩 — IN ('1m', '1h') 한 번에 찾지 않는다.
        expect(sql).toContain("c.interval = '1m'");
        expect(sql).toContain("c.interval = '1h'");
        expect(sql).not.toContain("c.interval IN ('1m', '1h')");
        return Promise.resolve([row("low", 11_000_000n, 10_000_000n), row("me", 9_000_000n, 10_000_000n), row("top", 15_000_000n, 10_000_000n)]);
      }),
      $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    };
    const service = new AccountService(prisma as never, new MemoCache());

    const board = await service.getLeaderboard("me", 2, "all");

    expect(calls).toEqual(["SET LOCAL jit = off", "ranking"]);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(board.total).toBe(3);
    // 상위 2명 + 순위 밖의 내 행
    expect(board.rows.map((r) => [r.rank, r.accountId, r.me])).toEqual([
      [1, "top", false],
      [2, "low", false],
      [3, "me", true],
    ]);
  });
});
