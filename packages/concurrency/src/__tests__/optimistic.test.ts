import { describe, expect, test } from "vitest";
import { FakeStore, makeFakePrisma } from "./fakes";
import { OptimisticMutator } from "../optimistic";
import { ConflictError } from "../errors";

const A = "aaaaaaaa-0000-0000-0000-000000000001";

function setup(balance = 1_000n) {
  const store = new FakeStore();
  store.addAccount(A, balance);
  const { prisma } = makeFakePrisma(store);
  const mutator = new OptimisticMutator(prisma as any, { maxRetries: 5, baseDelayMs: 1 });
  return { store, mutator };
}

describe("OptimisticMutator", () => {
  test("잔액을 읽고 검증하고 갱신한다", async () => {
    const { store, mutator } = setup(1_000n);

    await mutator.withAccountLock([A], async (ctx) => {
      const acc = ctx.accounts[A];
      await ctx.updateAccount(A, {
        balance: acc.balance - 300n,
        holdAmount: acc.holdAmount,
      });
    });

    expect(store.accounts.get(A)!.balance).toBe(700n);
    expect(store.accounts.get(A)!.version).toBe(1);
  });

  test("version 충돌 시 재시도해서 성공하고 retries 카운터가 증가한다", async () => {
    const { store, mutator } = setup(1_000n);
    let calls = 0;

    await mutator.withAccountLock([A], async (ctx) => {
      calls++;
      if (calls === 1) {
        // 동시 작성자가 끼어든 상황 시뮬레이션: 읽기 이후 version 변경
        store.accounts.get(A)!.version++;
      }
      const acc = ctx.accounts[A];
      await ctx.updateAccount(A, {
        balance: acc.balance - 100n,
        holdAmount: acc.holdAmount,
      });
    });

    expect(calls).toBe(2);
    expect(store.accounts.get(A)!.balance).toBe(900n);
    expect(mutator.getCounters().retries).toBe(1);
  });

  test("충돌이 계속되면 maxRetries 후 ConflictError를 던진다", async () => {
    const { store, mutator } = setup(1_000n);

    await expect(
      mutator.withAccountLock([A], async (ctx) => {
        store.accounts.get(A)!.version++; // 항상 충돌
        const acc = ctx.accounts[A];
        await ctx.updateAccount(A, {
          balance: acc.balance - 100n,
          holdAmount: acc.holdAmount,
        });
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    // 실패한 시도의 변경은 롤백되어야 한다
    expect(store.accounts.get(A)!.balance).toBe(1_000n);
    expect(mutator.getCounters().failures).toBe(1);
  });

  test("fn이 updateAccount를 호출하지 않아도 version을 올려 직렬화 지점을 만든다", async () => {
    const { store, mutator } = setup(1_000n);

    await mutator.withAccountLock([A], async () => {
      // 보유자산만 갱신하는 케이스 시뮬레이션 — 계좌는 건드리지 않음
    });

    expect(store.accounts.get(A)!.version).toBe(1);
  });
});
