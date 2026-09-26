import { futureDef, futureMarginPerContract } from "@mock-kabu/shared";
import { describe, expect, it, vi } from "vitest";
import { OrderService } from "../order.service";

describe("OrderService.myOrders", () => {
  it("keeps the existing account-wide query when no optional filter is supplied", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const service = new OrderService({ order: { findMany } } as never, {} as never, {} as never, {} as never);

    await service.myOrders("account-1", 50);

    expect(findMany).toHaveBeenCalledWith({
      where: { accountId: "account-1" },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
  });

  it("filters a bot reconciliation query to one account-owned symbol and live statuses", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const service = new OrderService({ order: { findMany } } as never, {} as never, {} as never, {} as never);

    await service.myOrders("account-1", 500, { symbol: " KABU ", liveOnly: true });

    expect(findMany).toHaveBeenCalledWith({
      where: {
        accountId: "account-1",
        symbol: "KABU",
        status: { in: ["OPEN", "PARTIAL"] },
      },
      orderBy: { createdAt: "desc" },
      take: 500,
    });
  });
});

describe("OrderService.place tick-size validation", () => {
  it("rejects a limit price off the symbol's tick grid before touching the database", async () => {
    const findUnique = vi.fn();
    const service = new OrderService(
      { marketSymbol: { findUnique } } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.place("account-1", { symbol: "GARM", side: "BUY", type: "LIMIT", price: 7_775, qty: 1 }),
    ).rejects.toThrow(/호가 단위는 10원/);
    expect(findUnique).not.toHaveBeenCalled();
  });
});

describe("OrderService.amend", () => {
  function liveOrder(overrides: Record<string, unknown> = {}) {
    return {
      id: "order-1",
      accountId: "account-1",
      symbol: "GARM",
      side: "BUY",
      type: "LIMIT",
      price: 7_000,
      qty: 10,
      filledQty: 2,
      status: "PARTIAL",
      ...overrides,
    };
  }

  it("does not place a replacement when the order fills before the cancel lands", async () => {
    const states = [liveOrder(), liveOrder({ status: "FILLED", filledQty: 10 })];
    const prisma = { order: { findUnique: vi.fn().mockImplementation(() => Promise.resolve(states.shift() ?? liveOrder({ status: "FILLED", filledQty: 10 }))) } };
    const service = new OrderService(prisma as never, {} as never, {} as never, {} as never);
    const cancel = vi.spyOn(service, "cancel").mockResolvedValue({ ok: true });
    const place = vi.spyOn(service, "place").mockResolvedValue({ id: "new" } as never);

    const result = await service.amend("account-1", "order-1", { price: 7_010 });

    expect(cancel).toHaveBeenCalledWith("account-1", "order-1");
    expect(place).not.toHaveBeenCalled();
    expect(result.amended).toBe(false);
  });

  it("re-places at most the quantity still unfilled after the cancel", async () => {
    const states = [liveOrder(), liveOrder({ status: "CANCELED", filledQty: 5 })];
    const prisma = { order: { findUnique: vi.fn().mockImplementation(() => Promise.resolve(states.shift() ?? liveOrder({ status: "CANCELED", filledQty: 5 }))) } };
    const service = new OrderService(prisma as never, {} as never, {} as never, {} as never);
    vi.spyOn(service, "cancel").mockResolvedValue({ ok: true });
    const place = vi.spyOn(service, "place").mockResolvedValue({ id: "new" } as never);

    const result = await service.amend("account-1", "order-1", { price: 7_010, qty: 8 });

    // 요청은 8주지만 취소 확인 시점의 미체결은 5주뿐이다.
    expect(place).toHaveBeenCalledWith("account-1", { symbol: "GARM", side: "BUY", type: "LIMIT", price: 7_010, qty: 5 });
    expect(result.amended).toBe(true);
  });

  it("rejects an amend that changes nothing or breaks the tick grid", async () => {
    const prisma = { order: { findUnique: vi.fn().mockResolvedValue(liveOrder()) } };
    const service = new OrderService(prisma as never, {} as never, {} as never, {} as never);
    await expect(service.amend("account-1", "order-1", { price: 7_000, qty: 8 })).rejects.toThrow(/바뀐 내용/);
    await expect(service.amend("account-1", "order-1", { price: 7_005 })).rejects.toThrow(/호가 단위/);
  });
});

describe("OrderService.place for futures", () => {
  function harness(balance: bigint, holdAmount = 0n, positionMargin = 0n, debt = 0n) {
    const accounts: Record<string, { balance: bigint; holdAmount: bigint }> = { a: { balance, holdAmount } };
    const created: Record<string, unknown>[] = [];
    const outbox: Record<string, unknown>[] = [];
    const tx = {
      futuresPosition: {
        aggregate: vi.fn(async () => ({ _sum: { marginHeld: positionMargin } })),
        // 포지션 없음(신규 주문) — 청산 판정·레버리지는 leverage.test.ts에서 따로 본다.
        findUnique: vi.fn(async () => null),
      },
      futuresDebt: { findUnique: vi.fn(async () => (debt > 0n ? { amount: debt } : null)) },
      holding: { findUnique: vi.fn(), update: vi.fn() },
      order: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => (created.push(data), { id: "o1", ...data })) },
      outbox: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => outbox.push(data)) },
    };
    const mutator = {
      withAccountLock: vi.fn(async (_ids: string[], fn: (ctx: unknown) => Promise<unknown>) =>
        fn({ accounts, tx, updateAccount: async (id: string, next: { balance: bigint; holdAmount: bigint }) => (accounts[id] = next) }),
      ),
    };
    const prisma = { marketSymbol: { findUnique: vi.fn(async () => ({ symbol: "KABUF", lastPrice: 88_000 })) } };
    const service = new OrderService(prisma as never, mutator as never, {} as never, { notifyAccount: vi.fn() } as never);
    return { service, accounts, created, outbox, tx };
  }

  it("holds the initial margin in cash for a short as well as a long, and never touches share holdings", async () => {
    const { service, accounts, created, tx } = harness(10_000_000n);
    await service.place("a", { symbol: "KABUF", side: "SELL", type: "LIMIT", price: 88_000, qty: 2 });
    // 880.00pt × 10,000원 × 21.75% = 1,914,000원/계약
    expect(created[0].holdPerUnit).toBe(1_914_000n);
    expect(accounts.a.holdAmount).toBe(3_828_000n);
    expect(tx.holding.findUnique).not.toHaveBeenCalled();
  });

  it("counts position margin and debt against the available cash", async () => {
    const { service } = harness(3_000_000n, 0n, 1_000_000n, 200_000n);
    // 가용 = 300만 − 100만(포지션 증거금) − 20만(미수) = 180만 < 1계약 증거금 191만4천
    await expect(
      service.place("a", { symbol: "KABUF", side: "BUY", type: "LIMIT", price: 88_000, qty: 1 }),
    ).rejects.toThrow(/증거금이 부족/);
  });

  it("caps contracts per order and enforces the futures tick grid", async () => {
    const { service } = harness(1_000_000_000n);
    await expect(service.place("a", { symbol: "KABUF", side: "BUY", type: "LIMIT", price: 88_000, qty: 101 })).rejects.toThrow(/100계약/);
    await expect(service.place("a", { symbol: "KABUF", side: "BUY", type: "LIMIT", price: 88_003, qty: 1 })).rejects.toThrow(/호가 단위/);
  });

  it("sends a market buy with a price cap in contract price units, separate from the margin hold", async () => {
    const { service, outbox, created } = harness(100_000_000n);
    await service.place("a", { symbol: "KABUF", side: "BUY", type: "MARKET", qty: 1 });
    const payload = outbox[0].payload as { price: number };
    expect(payload.price).toBe(Math.ceil(88_000 * 1.1));
    // 증거금은 체결 상한(최근가 × 1.1, 올림) 기준
    expect(created[0].holdPerUnit).toBe(futureMarginPerContract(futureDef("KABUF")!, Math.ceil(88_000 * 1.1)));
  });
});

describe("OrderService.cancel", () => {
  function setup() {
    const keys = new Map<string, string>();
    const redis = {
      set: vi.fn(async (key: string, value: string, _ex: string, _ttl: number, _nx: string) => {
        if (keys.has(key)) return null;
        keys.set(key, value);
        return "OK";
      }),
      del: vi.fn(async (key: string) => keys.delete(key)),
    };
    const create = vi.fn(async () => undefined);
    const prisma = {
      order: { findUnique: vi.fn(async () => ({ id: "o1", accountId: "a1", symbol: "GARM", status: "OPEN" })) },
      outbox: { create },
    };
    const service = new OrderService(prisma as never, {} as never, redis as never, {} as never);
    return { service, create, redis, keys };
  }

  it("writes one cancel event per order within the dedupe window, however often DELETE is re-sent", async () => {
    const h = setup();
    await expect(h.service.cancel("a1", "o1")).resolves.toEqual({ ok: true });
    await expect(h.service.cancel("a1", "o1")).resolves.toEqual({ ok: true, duplicate: true });
    await h.service.cancel("a1", "o1");
    expect(h.create).toHaveBeenCalledTimes(1);
  });

  it("releases the dedupe mark when the outbox write fails so a retry can go through", async () => {
    const h = setup();
    h.create.mockRejectedValueOnce(new Error("db down"));
    await expect(h.service.cancel("a1", "o1")).rejects.toThrow("db down");
    await h.service.cancel("a1", "o1");
    expect(h.create).toHaveBeenCalledTimes(2);
  });
});
