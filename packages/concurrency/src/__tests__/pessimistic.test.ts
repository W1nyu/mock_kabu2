import { describe, expect, test } from "vitest";
import { FakeStore, makeFakePrisma } from "./fakes";
import { PessimisticMutator } from "../pessimistic";

const A = "aaaaaaaa-0000-0000-0000-000000000001";
const B = "bbbbbbbb-0000-0000-0000-000000000002";

describe("PessimisticMutator", () => {
  test("SELECT ... FOR UPDATE로 잠근 뒤 갱신한다", async () => {
    const store = new FakeStore();
    store.addAccount(A, 500n);
    const { prisma, queryLog } = makeFakePrisma(store);
    const mutator = new PessimisticMutator(prisma as any);

    await mutator.withAccountLock([A], async (ctx) => {
      const acc = ctx.accounts[A];
      await ctx.updateAccount(A, {
        balance: acc.balance + 100n,
        holdAmount: acc.holdAmount,
      });
    });

    expect(store.accounts.get(A)!.balance).toBe(600n);
    const lockQueries = queryLog.filter((q) => q.sql.includes("FOR UPDATE"));
    expect(lockQueries).toHaveLength(1);
  });

  test("여러 계좌는 항상 ID 오름차순으로 잠근다 (데드락 방지)", async () => {
    const store = new FakeStore();
    store.addAccount(A, 500n);
    store.addAccount(B, 500n);
    const { prisma, queryLog } = makeFakePrisma(store);
    const mutator = new PessimisticMutator(prisma as any);

    // 내림차순으로 요청해도
    await mutator.withAccountLock([B, A], async (ctx) => {
      expect(Object.keys(ctx.accounts).sort()).toEqual([A, B]);
    });

    const lockedIds = queryLog
      .filter((q) => q.sql.includes("FOR UPDATE"))
      .map((q) => q.args[0]);
    expect(lockedIds).toEqual([A, B]); // 오름차순
  });

  test("lock_timeout을 트랜잭션에 설정한다", async () => {
    const store = new FakeStore();
    store.addAccount(A, 500n);
    const { prisma, queryLog } = makeFakePrisma(store);
    const mutator = new PessimisticMutator(prisma as any);

    await mutator.withAccountLock([A], async () => {});

    const timeoutSet = queryLog.some((q) => q.sql.toLowerCase().includes("lock_timeout"));
    expect(timeoutSet).toBe(true);
  });
});
