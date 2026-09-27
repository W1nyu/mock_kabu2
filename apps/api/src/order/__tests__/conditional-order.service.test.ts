import { UnprocessableEntityException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { ConditionalOrderService } from "../conditional-order.service";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function waitingRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "cond-1",
    accountId: "acct-1",
    symbol: "KABU",
    side: "SELL",
    direction: "AT_OR_BELOW",
    triggerPrice: 1_000,
    qty: 5,
    orderType: "MARKET",
    limitPrice: null,
    positionSide: null,
    ocoGroupId: null,
    trailBps: null,
    watermark: null,
    status: "WAITING",
    triggeredOrderId: null,
    triggerTradePrice: null,
    failReason: null,
    triggeredAt: null,
    createdAt: new Date("2026-09-22T00:00:00Z"),
    ...overrides,
  };
}

function build(
  options: {
    rows?: ReturnType<typeof waitingRow>[];
    claimCount?: number;
    placeError?: Error;
    /** 선물 포지션 "계좌|종목|방향(LONG/SHORT/NET)" → 부호 있는 계약 수 */
    positions?: Map<string, number>;
    /** 계정이 봇인지. 기본값 true — 지정 안 하면 기존 NET(순포지션) 테스트와 동일하게 동작 */
    isBot?: boolean;
  } = {},
) {
  const positions = options.positions ?? new Map<string, number>();
  const isBot = options.isBot ?? true;
  const prisma = {
    account: { findUnique: vi.fn().mockResolvedValue({ userId: "u" }) },
    user: { findUnique: vi.fn().mockResolvedValue({ isBot }) },
    futuresPosition: {
      findUnique: vi.fn().mockImplementation(({ where }: any) => {
        const { accountId, symbol, positionSide } = where.accountId_symbol_positionSide;
        const qty = positions.get(`${accountId}|${symbol}|${positionSide}`);
        return Promise.resolve(qty == null ? null : { qty });
      }),
      findMany: vi.fn().mockImplementation(({ where }: any) =>
        Promise.resolve(
          (where.OR as { accountId: string; symbol: string }[]).flatMap((k) =>
            [...positions.entries()]
              .filter(([key]) => key.startsWith(`${k.accountId}|${k.symbol}|`))
              .map(([key, qty]) => ({ accountId: k.accountId, symbol: k.symbol, positionSide: key.split("|")[2], qty })),
          ),
        ),
      ),
    },
    conditionalOrder: {
      findMany: vi.fn().mockImplementation((args: any) =>
        // 인덱스 적재(status=WAITING만)와 OCO 짝 조회(ocoGroupId + id not)를 같은 fixture로 응답한다.
        Promise.resolve(
          (options.rows ?? [waitingRow()]).filter((row) =>
            args?.where?.ocoGroupId
              ? row.ocoGroupId === args.where.ocoGroupId && row.id !== args.where.id?.not
              : true,
          ),
        ),
      ),
      updateMany: vi.fn().mockResolvedValue({ count: options.claimCount ?? 1 }),
      update: vi.fn().mockResolvedValue({}),
    },
    marketSymbol: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const orders = {
    place: options.placeError
      ? vi.fn().mockRejectedValue(options.placeError)
      : vi.fn().mockResolvedValue({ id: "order-9" }),
  };
  const realtime = { notifyAccount: vi.fn() };
  const sub = { on: vi.fn(), off: vi.fn(), psubscribe: vi.fn().mockResolvedValue(1) };
  const service = new ConditionalOrderService(prisma as never, sub as never, orders as never, realtime as never);
  return { service, prisma, orders, realtime, positions };
}

describe("ConditionalOrderService trigger loop", () => {
  it("ignores prints that do not satisfy the condition", async () => {
    const { service, prisma, orders } = build();
    await (service as any).reloadIndex();

    service.onTick("KABU", 1_001);
    await flush();

    expect(prisma.conditionalOrder.updateMany).not.toHaveBeenCalled();
    expect(orders.place).not.toHaveBeenCalled();
  });

  it("claims the row once, places the market order, and records the order id", async () => {
    const { service, prisma, orders, realtime } = build();
    await (service as any).reloadIndex();

    service.onTick("KABU", 1_000);
    // 같은 프로세스에서 곧바로 두 번째 체결이 와도 인덱스에서 이미 빠져 있다.
    service.onTick("KABU", 990);
    await flush();

    expect(prisma.conditionalOrder.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.conditionalOrder.updateMany).toHaveBeenCalledWith({
      where: { id: "cond-1", status: "WAITING" },
      data: expect.objectContaining({ status: "TRIGGERED", triggerTradePrice: 1_000 }),
    });
    expect(orders.place).toHaveBeenCalledWith("acct-1", { symbol: "KABU", side: "SELL", type: "MARKET", qty: 5 });
    expect(prisma.conditionalOrder.update).toHaveBeenCalledWith({
      where: { id: "cond-1" },
      data: { triggeredOrderId: "order-9" },
    });
    expect(realtime.notifyAccount).toHaveBeenCalledWith(
      "acct-1",
      expect.objectContaining({ type: "conditional", status: "TRIGGERED", orderId: "order-9" }),
    );
  });

  it("does not place an order when another instance already claimed the row", async () => {
    const { service, orders } = build({ claimCount: 0 });
    await (service as any).reloadIndex();

    service.onTick("KABU", 900);
    await flush();

    expect(orders.place).not.toHaveBeenCalled();
  });

  it("marks the row FAILED with the rejection reason when placement is refused", async () => {
    const { service, prisma, realtime } = build({
      placeError: new UnprocessableEntityException("매도 가능 수량이 부족합니다"),
    });
    await (service as any).reloadIndex();

    service.onTick("KABU", 900);
    await flush();

    expect(prisma.conditionalOrder.update).toHaveBeenCalledWith({
      where: { id: "cond-1" },
      data: { status: "FAILED", failReason: "매도 가능 수량이 부족합니다" },
    });
    expect(realtime.notifyAccount).toHaveBeenCalledWith(
      "acct-1",
      expect.objectContaining({ status: "FAILED", failReason: "매도 가능 수량이 부족합니다" }),
    );
  });

  it("passes the limit price through for a LIMIT-at-trigger order", async () => {
    const { service, orders } = build({
      rows: [waitingRow({ side: "BUY", direction: "AT_OR_ABOVE", triggerPrice: 1_200, orderType: "LIMIT", limitPrice: 1_210 })],
    });
    await (service as any).reloadIndex();

    service.onTick("KABU", 1_250);
    await flush();

    expect(orders.place).toHaveBeenCalledWith("acct-1", {
      symbol: "KABU",
      side: "BUY",
      type: "LIMIT",
      qty: 5,
      price: 1_210,
    });
  });

  it("cancels the OCO sibling when one leg triggers", async () => {
    const stop = waitingRow({ id: "stop", direction: "AT_OR_BELOW", triggerPrice: 900, ocoGroupId: "g1" });
    const take = waitingRow({ id: "take", direction: "AT_OR_ABOVE", triggerPrice: 1_100, ocoGroupId: "g1" });
    const { service, prisma, orders } = build({ rows: [stop, take] });
    await (service as any).reloadIndex();

    service.onTick("KABU", 1_100);
    await flush();

    // 짝(stop)은 WAITING→CANCELED로, 인덱스에서도 빠져 뒤이은 하락 체결에 발동하지 않는다.
    expect(prisma.conditionalOrder.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["stop"] }, status: "WAITING" },
      data: { status: "CANCELED", failReason: "OCO 짝 주문 발동으로 자동 취소" },
    });
    service.onTick("KABU", 800);
    await flush();
    expect(orders.place).toHaveBeenCalledTimes(1);
  });
});

function buildForPlace(
  lastPrice: number,
  waitingCount = 0,
  extra: {
    /** 선물 포지션 "계좌|종목|방향(LONG/SHORT/NET)" → 부호 있는 계약 수 */
    positions?: Map<string, number>;
    /** 계정이 봇인지. 기본값 true */
    isBot?: boolean;
    orders?: { place: ReturnType<typeof vi.fn> };
  } = {},
) {
  const positions = extra.positions ?? new Map<string, number>();
  const isBot = extra.isBot ?? true;
  const prisma = {
    account: { findUnique: vi.fn().mockResolvedValue({ userId: "u" }) },
    user: { findUnique: vi.fn().mockResolvedValue({ isBot }) },
    futuresPosition: {
      findUnique: vi.fn().mockImplementation(({ where }: any) => {
        const { accountId, symbol, positionSide } = where.accountId_symbol_positionSide;
        const qty = positions.get(`${accountId}|${symbol}|${positionSide}`);
        return Promise.resolve(qty == null ? null : { qty });
      }),
    },
    conditionalOrder: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(waitingCount),
      create: vi.fn().mockImplementation(({ data }: any) =>
        Promise.resolve({
          ...waitingRow(),
          ...data,
          id: `${data.direction}-${data.triggerPrice}`,
          createdAt: new Date(),
        }),
      ),
    },
    marketSymbol: { findUnique: vi.fn().mockResolvedValue({ symbol: "KABU", lastPrice }) },
    $transaction: vi.fn().mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  const realtime = { notifyAccount: vi.fn() };
  const sub = { on: vi.fn(), off: vi.fn(), psubscribe: vi.fn().mockResolvedValue(1) };
  const orders = extra.orders ?? { place: vi.fn().mockResolvedValue({ id: "order-9" }) };
  const service = new ConditionalOrderService(prisma as never, sub as never, orders as never, realtime as never);
  return { service, prisma, orders };
}

describe("ConditionalOrderService placement validation", () => {
  it("rejects a trigger the current price already satisfies", async () => {
    const { service } = buildForPlace(1_000);
    await expect(
      service.place("acct-1", { symbol: "KABU", side: "SELL", direction: "AT_OR_BELOW", triggerPrice: 1_000, qty: 1 }),
    ).rejects.toThrow(/이미/);
  });

  it("creates an OCO pair sharing one group id and keeps both in the index", async () => {
    const { service, prisma } = buildForPlace(1_000);
    const rows = await service.placeOco("acct-1", { symbol: "KABU", side: "SELL", qty: 3, lowerPrice: 900, upperPrice: 1_100 });

    expect(rows).toHaveLength(2);
    expect(rows[0].ocoGroupId).toBeTruthy();
    expect(rows[0].ocoGroupId).toBe(rows[1].ocoGroupId);
    expect(rows.map((r) => r.direction).sort()).toEqual(["AT_OR_ABOVE", "AT_OR_BELOW"]);
    expect(prisma.conditionalOrder.create).toHaveBeenCalledTimes(2);
    expect((service as any).waiting.get("KABU").size).toBe(2);
  });

  it("rejects an OCO whose legs are not on opposite sides of the current price", async () => {
    const { service } = buildForPlace(1_000);
    await expect(
      service.placeOco("acct-1", { symbol: "KABU", side: "SELL", qty: 3, lowerPrice: 1_100, upperPrice: 1_200 }),
    ).rejects.toThrow(/이미/);
    await expect(
      service.placeOco("acct-1", { symbol: "KABU", side: "SELL", qty: 3, lowerPrice: 950, upperPrice: 940 }),
    ).rejects.toThrow(/낮아야/);
  });

  it("enforces the per-account waiting cap counting both OCO legs", async () => {
    const { service } = buildForPlace(1_000, 49);
    await expect(
      service.placeOco("acct-1", { symbol: "KABU", side: "SELL", qty: 3, lowerPrice: 900, upperPrice: 1_100 }),
    ).rejects.toThrow(/50건/);
  });
});

describe("ConditionalOrderService trailing stops", () => {
  it("ratchets the trigger up with new highs and fires on the pullback", async () => {
    const trailing = waitingRow({
      id: "trail",
      direction: "AT_OR_BELOW",
      triggerPrice: 970,
      trailBps: 300,
      watermark: 1_000,
    });
    const { service, prisma, orders } = build({ rows: [trailing] });
    await (service as any).reloadIndex();

    service.onTick("KABU", 1_100); // 새 고점 → 트리거 1,067
    await flush();
    expect(orders.place).not.toHaveBeenCalled();
    expect(prisma.conditionalOrder.updateMany).toHaveBeenCalledWith({
      where: { id: "trail", status: "WAITING", OR: [{ watermark: null }, { watermark: { lt: 1_100 } }] },
      data: { triggerPrice: 1_067, watermark: 1_100 },
    });

    service.onTick("KABU", 1_070); // 고점 대비 -2.7% — 아직
    await flush();
    expect(orders.place).not.toHaveBeenCalled();

    service.onTick("KABU", 1_067); // -3% 도달
    await flush();
    expect(orders.place).toHaveBeenCalledTimes(1);
  });
});

describe("ConditionalOrderService trailing reload", () => {
  it("keeps a fresher in-memory watermark when the periodic reload returns a stale row", async () => {
    const stale = waitingRow({ id: "trail", direction: "AT_OR_BELOW", triggerPrice: 970, trailBps: 300, watermark: 1_000 });
    const { service, orders } = build({ rows: [stale] });
    await (service as any).reloadIndex();
    service.onTick("KABU", 1_200); // 메모리: watermark 1,200 / trigger 1,164
    await flush();

    await (service as any).reloadIndex(); // DB는 아직 1,000/970을 돌려준다
    const row = (service as any).waiting.get("KABU").get("trail");
    expect(row.watermark).toBe(1_200);
    expect(row.triggerPrice).toBe(1_164);

    service.onTick("KABU", 1_100); // 옛 트리거(970)였다면 발동하지 않았을 값 — 새 트리거 1,164 이하이므로 발동
    await flush();
    expect(orders.place).toHaveBeenCalledTimes(1);
  });
});

describe("futures conditional orders only ever close the position", () => {
  const futureRow = (overrides: Partial<Record<string, unknown>> = {}) =>
    waitingRow({ symbol: "KABUF", side: "SELL", direction: "AT_OR_BELOW", triggerPrice: 87_000, qty: 5, ...overrides });

  it("clamps the stop to the contracts still held when it fires", async () => {
    const { service, orders } = build({ rows: [futureRow()], positions: new Map([["acct-1|KABUF|NET", 3]]) });
    await (service as any).reloadIndex();

    service.onTick("KABUF", 86_995);
    await flush();

    expect(orders.place).toHaveBeenCalledWith("acct-1", { symbol: "KABUF", side: "SELL", type: "MARKET", qty: 3 });
  });

  it("cancels instead of opening a new position when the position is gone at trigger time", async () => {
    const { service, prisma, orders, positions } = build({ rows: [futureRow()], positions: new Map([["acct-1|KABUF|NET", 5]]) });
    await (service as any).reloadIndex();
    positions.set("acct-1|KABUF|NET", 0); // 사용자가 전량 청산했다(다음 인덱스 재적재 전)

    service.onTick("KABUF", 86_000);
    await flush();

    expect(orders.place).not.toHaveBeenCalled();
    expect(prisma.conditionalOrder.update).toHaveBeenCalledWith({
      where: { id: "cond-1" },
      data: { status: "CANCELED", failReason: expect.stringContaining("포지션이 없어") },
    });
  });

  it("sweeps waiting stops whose position was closed, settled or flipped when the index reloads", async () => {
    const { service, prisma, orders } = build({
      rows: [futureRow(), futureRow({ id: "cond-2", accountId: "acct-2" })],
      positions: new Map([
        ["acct-1|KABUF|NET", 2],
        ["acct-2|KABUF|NET", -4], // 롱이 숏으로 뒤집혔다 — 매도 손절은 의미가 없다
      ]),
    });
    await (service as any).reloadIndex();

    expect(prisma.conditionalOrder.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["cond-2"] }, status: "WAITING" },
      data: { status: "CANCELED", failReason: expect.stringContaining("포지션이 없어") },
    });
    service.onTick("KABUF", 86_000);
    await flush();
    expect(orders.place).toHaveBeenCalledTimes(1);
    expect(orders.place).toHaveBeenCalledWith("acct-1", expect.objectContaining({ qty: 2 }));
  });

  it("refuses to register a futures stop without a position to close", async () => {
    const { service } = build({ rows: [] });
    await expect(
      service.place("acct-1", { symbol: "KABUF", side: "SELL", direction: "AT_OR_BELOW", triggerPrice: 87_000, qty: 1 }),
    ).rejects.toThrow(/청산하는 방향으로만/);
  });
});

describe("human futures conditional orders close a hedge side (LONG/SHORT), not the net position", () => {
  it("assigns the position side that the order side closes and clamps qty to what that side holds", async () => {
    const positions = new Map([
      ["acct-1|KABUF|LONG", 3],
      ["acct-1|KABUF|SHORT", -2],
    ]);
    const { service } = buildForPlace(86_500, 0, { positions, isBot: false });

    const row = await service.place("acct-1", {
      symbol: "KABUF",
      side: "BUY",
      qty: 2,
      direction: "AT_OR_ABOVE",
      triggerPrice: 87_000,
    });
    expect(row.positionSide).toBe("SHORT");

    await expect(
      service.place("acct-1", {
        symbol: "KABUF",
        side: "BUY",
        qty: 3,
        direction: "AT_OR_ABOVE",
        triggerPrice: 87_000,
      }),
    ).rejects.toThrow(/청산할 수 있는 수량은 2계약/);
  });

  it("passes the position side through to the market order when it fires", async () => {
    const shortStop = waitingRow({
      symbol: "KABUF",
      side: "BUY",
      direction: "AT_OR_ABOVE",
      triggerPrice: 87_000,
      qty: 2,
      positionSide: "SHORT",
    });
    const { service, orders } = build({
      rows: [shortStop],
      isBot: false,
      positions: new Map([["acct-1|KABUF|SHORT", -2]]),
    });
    await (service as any).reloadIndex();

    service.onTick("KABUF", 87_000);
    await flush();

    expect(orders.place).toHaveBeenCalledWith("acct-1", {
      symbol: "KABUF",
      side: "BUY",
      type: "MARKET",
      qty: 2,
      positionSide: "SHORT",
    });
  });

  it("stamps both OCO legs with the closing position side and clamps qty to what that side holds", async () => {
    const positions = new Map([
      ["acct-1|KABUF|LONG", 3],
      ["acct-1|KABUF|SHORT", -2],
    ]);
    const { service } = buildForPlace(87_000, 0, { positions, isBot: false });

    const rows = await service.placeOco("acct-1", {
      symbol: "KABUF",
      side: "BUY",
      qty: 2,
      lowerPrice: 86_000,
      upperPrice: 88_000,
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.positionSide)).toEqual(["SHORT", "SHORT"]);

    await expect(
      service.placeOco("acct-1", {
        symbol: "KABUF",
        side: "BUY",
        qty: 3,
        lowerPrice: 86_000,
        upperPrice: 88_000,
      }),
    ).rejects.toThrow(/청산할 수 있는 수량은 2계약/);
  });
});
