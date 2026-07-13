import { describe, expect, test } from "vitest";
import { applyOrder, cancelOrder, createBook, levels, type IncomingOrder } from "../orderbook";

let seq = 0;
function order(partial: Partial<IncomingOrder> & Pick<IncomingOrder, "side" | "qty">): IncomingOrder {
  seq++;
  return {
    orderId: partial.orderId ?? `o${seq}`,
    accountId: partial.accountId ?? `acc-${partial.side}`,
    type: partial.type ?? (partial.price != null ? "LIMIT" : "MARKET"),
    price: partial.price ?? null,
    ts: seq,
    ...partial,
  } as IncomingOrder;
}

describe("orderbook 매칭 (가격-시간 우선)", () => {
  test("빈 북에 LIMIT 매수는 체결 없이 bids에 등재된다", () => {
    const book = createBook("MOCK");
    const res = applyOrder(book, order({ side: "BUY", price: 100, qty: 10 }));

    expect(res.fills).toHaveLength(0);
    expect(res.restingQty).toBe(10);
    expect(book.bids).toHaveLength(1);
    expect(book.bids[0].price).toBe(100);
  });

  test("가격이 교차하면 메이커 가격으로 체결된다", () => {
    const book = createBook("MOCK");
    applyOrder(book, order({ orderId: "sell1", side: "SELL", price: 100, qty: 10 }));
    const res = applyOrder(book, order({ orderId: "buy1", side: "BUY", price: 105, qty: 10 }));

    expect(res.fills).toHaveLength(1);
    expect(res.fills[0]).toMatchObject({
      price: 100, // 테이커 105가 아니라 메이커 100
      qty: 10,
      makerOrderId: "sell1",
      takerOrderId: "buy1",
      takerSide: "BUY",
    });
    expect(book.asks).toHaveLength(0);
    expect(book.bids).toHaveLength(0);
    expect(book.lastPrice).toBe(100);
    // 양쪽 모두 완전 체결로 종료
    expect(res.closedOrders.map((c) => c.orderId).sort()).toEqual(["buy1", "sell1"]);
    expect(res.closedOrders.every((c) => c.status === "FILLED")).toBe(true);
  });

  test("가격 우선: 더 좋은 호가부터 체결된다", () => {
    const book = createBook("MOCK");
    applyOrder(book, order({ orderId: "s50", side: "SELL", price: 50, qty: 5 }));
    applyOrder(book, order({ orderId: "s49", side: "SELL", price: 49, qty: 5 }));
    const res = applyOrder(book, order({ side: "BUY", price: 51, qty: 10 }));

    expect(res.fills.map((f) => f.price)).toEqual([49, 50]);
  });

  test("시간 우선: 같은 가격이면 먼저 온 주문부터 체결된다", () => {
    const book = createBook("MOCK");
    applyOrder(book, order({ orderId: "first", side: "SELL", price: 100, qty: 5 }));
    applyOrder(book, order({ orderId: "second", side: "SELL", price: 100, qty: 5 }));
    const res = applyOrder(book, order({ side: "BUY", price: 100, qty: 5 }));

    expect(res.fills[0].makerOrderId).toBe("first");
    expect(book.asks[0].orderId).toBe("second");
  });

  test("부분 체결: 잔량은 북에 등재되고 메이커는 PARTIAL 상태로 남는다", () => {
    const book = createBook("MOCK");
    applyOrder(book, order({ orderId: "sell1", side: "SELL", price: 100, qty: 50 }));
    const res = applyOrder(book, order({ orderId: "buy1", side: "BUY", price: 100, qty: 80 }));

    expect(res.fills[0].qty).toBe(50);
    expect(res.restingQty).toBe(30);
    expect(book.bids[0]).toMatchObject({ orderId: "buy1", qty: 30 });
    // sell1은 완전 체결 종료, buy1은 아직 열려있으므로 closed에 없음
    expect(res.closedOrders.map((c) => c.orderId)).toEqual(["sell1"]);
  });

  test("가격이 교차하지 않으면 체결되지 않는다", () => {
    const book = createBook("MOCK");
    applyOrder(book, order({ side: "SELL", price: 101, qty: 10 }));
    const res = applyOrder(book, order({ side: "BUY", price: 100, qty: 10 }));

    expect(res.fills).toHaveLength(0);
    expect(book.bids).toHaveLength(1);
    expect(book.asks).toHaveLength(1);
  });

  test("MARKET 주문은 북을 소진하고 잔량은 취소된다(IOC)", () => {
    const book = createBook("MOCK");
    applyOrder(book, order({ orderId: "s1", side: "SELL", price: 100, qty: 5 }));
    const res = applyOrder(book, order({ orderId: "m1", side: "BUY", type: "MARKET", qty: 8 }));

    expect(res.fills).toHaveLength(1);
    expect(res.fills[0].qty).toBe(5);
    expect(res.canceledQty).toBe(3);
    expect(res.restingQty).toBe(0);
    // 시장가 주문 자신도 종료된다 (부분 체결 후 잔량 취소 → CANCELED)
    const m1 = res.closedOrders.find((c) => c.orderId === "m1");
    expect(m1).toMatchObject({ filledQty: 5, status: "CANCELED" });
  });

  test("가격 상한이 있는 MARKET 매수는 상한 초과 호가를 소진하지 않는다 (홀드 보호)", () => {
    const book = createBook("MOCK");
    applyOrder(book, order({ orderId: "s90", side: "SELL", price: 90, qty: 5 }));
    applyOrder(book, order({ orderId: "s110", side: "SELL", price: 110, qty: 5 }));
    const res = applyOrder(book, order({ orderId: "m1", side: "BUY", type: "MARKET", price: 100, qty: 10 }));

    expect(res.fills).toHaveLength(1);
    expect(res.fills[0].price).toBe(90);
    expect(res.canceledQty).toBe(5); // 110은 상한 초과 → 잔량 취소
    expect(book.asks[0].orderId).toBe("s110");
  });

  test("빈 북에 MARKET 주문은 전량 취소된다", () => {
    const book = createBook("MOCK");
    const res = applyOrder(book, order({ orderId: "m1", side: "SELL", type: "MARKET", qty: 10 }));

    expect(res.fills).toHaveLength(0);
    expect(res.canceledQty).toBe(10);
    expect(res.closedOrders[0]).toMatchObject({ orderId: "m1", status: "CANCELED", filledQty: 0 });
  });

  test("cancelOrder는 북에서 주문을 제거한다", () => {
    const book = createBook("MOCK");
    applyOrder(book, order({ orderId: "b1", side: "BUY", price: 90, qty: 10 }));
    const removed = cancelOrder(book, "b1");

    expect(removed?.orderId).toBe("b1");
    expect(book.bids).toHaveLength(0);
    expect(cancelOrder(book, "없는주문")).toBeNull();
  });

  test("levels는 같은 가격을 합산하고 depth를 제한한다", () => {
    const book = createBook("MOCK");
    applyOrder(book, order({ side: "BUY", price: 100, qty: 3 }));
    applyOrder(book, order({ side: "BUY", price: 100, qty: 7 }));
    applyOrder(book, order({ side: "BUY", price: 99, qty: 5 }));
    applyOrder(book, order({ side: "BUY", price: 98, qty: 5 }));
    applyOrder(book, order({ side: "SELL", price: 101, qty: 4 }));

    const { bids, asks } = levels(book, 2);
    expect(bids).toEqual([
      { price: 100, qty: 10 },
      { price: 99, qty: 5 },
    ]);
    expect(asks).toEqual([{ price: 101, qty: 4 }]);
  });

  test("prevents a self-cross by canceling the incoming remainder", () => {
    const book = createBook("MOCK");
    applyOrder(book, order({ orderId: "own-ask", accountId: "bot-1", side: "SELL", price: 100, qty: 5 }));
    applyOrder(book, order({ orderId: "other-ask", accountId: "bot-2", side: "SELL", price: 101, qty: 5 }));

    const res = applyOrder(book, order({ orderId: "own-buy", accountId: "bot-1", side: "BUY", type: "MARKET", qty: 8 }));

    expect(res.fills).toEqual([]);
    expect(res.canceledQty).toBe(8);
    expect(res.closedOrders).toContainEqual({
      orderId: "own-buy",
      accountId: "bot-1",
      side: "BUY",
      filledQty: 0,
      status: "CANCELED",
    });
    expect(book.asks.map((resting) => resting.orderId)).toEqual(["own-ask", "other-ask"]);
  });
});
