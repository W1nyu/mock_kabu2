import { describe, expect, test } from "vitest";
import { FakeRedis, FakeStore, makeFakePrisma } from "./fakes";
import { DistributedMutator } from "../distributed";
import { FencingError } from "../errors";

const A = "aaaaaaaa-0000-0000-0000-000000000001";

function setup() {
  const store = new FakeStore();
  store.addAccount(A, 1_000n);
  const { prisma } = makeFakePrisma(store);
  const redis = new FakeRedis();
  const mutator = new DistributedMutator(prisma as any, redis as any, {
    ttlMs: 1_000,
    acquireTimeoutMs: 500,
    retryDelayMs: 5,
  });
  return { store, redis, mutator };
}

describe("DistributedMutator", () => {
  test("락을 획득해 갱신하고, 종료 후 자기 락만 해제한다", async () => {
    const { store, redis, mutator } = setup();

    await mutator.withAccountLock([A], async (ctx) => {
      // 임계 구역 안에서는 redis에 락 키가 존재
      expect(redis.data.has(`mock-kabu2:lock:account:${A}`)).toBe(true);
      const acc = ctx.accounts[A];
      await ctx.updateAccount(A, {
        balance: acc.balance - 500n,
        holdAmount: acc.holdAmount,
      });
    });

    expect(store.accounts.get(A)!.balance).toBe(500n);
    expect(redis.data.has(`mock-kabu2:lock:account:${A}`)).toBe(false);
  });

  test("동시 접근은 락으로 직렬화된다 (증분 유실 없음)", async () => {
    const { store, mutator } = setup();

    await Promise.all(
      Array.from({ length: 10 }, () =>
        mutator.withAccountLock([A], async (ctx) => {
          const acc = ctx.accounts[A];
          // 읽기→쓰기 사이 양보로 인터리빙 기회를 만든다
          await new Promise((r) => setTimeout(r, 1));
          await ctx.updateAccount(A, {
            balance: acc.balance + 100n,
            holdAmount: acc.holdAmount,
          });
        }),
      ),
    );

    expect(store.accounts.get(A)!.balance).toBe(2_000n);
  });

  test("fencing token이 뒤처지면 DB 갱신을 거부한다 (좀비 프로세스 방어)", async () => {
    const { store, mutator } = setup();
    // DB에 이미 더 높은 fencing token이 기록된 상황
    store.accounts.get(A)!.fencing_token = 999n;

    await expect(
      mutator.withAccountLock([A], async (ctx) => {
        const acc = ctx.accounts[A];
        await ctx.updateAccount(A, {
          balance: acc.balance - 100n,
          holdAmount: acc.holdAmount,
        });
      }),
    ).rejects.toBeInstanceOf(FencingError);

    expect(store.accounts.get(A)!.balance).toBe(1_000n);
  });
});
