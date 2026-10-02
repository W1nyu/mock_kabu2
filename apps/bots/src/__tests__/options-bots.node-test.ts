import assert from "node:assert/strict";
import { test } from "node:test";
import { OPTION_MM_MAX_INVENTORY, closingOrder, diffOptionLadder, heldToExpiry, optionLevelQty, pickOptionByOffset, pickStaleOption, pickStrikeOffset, planOptionLadder, strikeSteps } from "../options-bots";

// 주가지수(K): 0.05pt 호가 = 5단위, 1단위 100원. 원/달러(U): 0.1원 호가 = 1단위, 1단위 1,000원.
const K = { tickUnits: 5, unitValue: 100 };
const U = { tickUnits: 1, unitValue: 1_000 };

test("option ladder: 3 levels each side around theo with a 4% half-spread (min 1 tick)", () => {
  // 이론가 5.00pt(500단위), 호가 5단위: 한쪽 스프레드 20 → 매수 480/475/470, 매도 520/525/530
  const quotes = planOptionLadder(K, 500, 0);
  assert.deepEqual(
    quotes.filter((q) => q.side === "BUY").map((q) => [q.price, q.qty]),
    [[480, 5], [475, 8], [470, 10]],
  );
  assert.deepEqual(quotes.filter((q) => q.side === "SELL").map((q) => q.price), [520, 525, 530]);
});

test("option ladder: cheap options quote tens of contracts, expensive ones a few", () => {
  // 100pt(100만 원) → 2·3·4, 4pt → 6·9·12, 1pt → 12·18·24, 0.1pt(1천 원) → 20·30·40
  const sizes = (theo: number) => planOptionLadder(K, theo, 0).filter((q) => q.side === "SELL").map((q) => q.qty);
  assert.deepEqual(sizes(10_000), [2, 3, 4]);
  assert.deepEqual(sizes(400), [6, 9, 12]);
  assert.deepEqual(sizes(100), [12, 18, 24]);
  assert.deepEqual(sizes(10), [20, 30, 40]);
  assert.equal(optionLevelQty(0, 100), 20);
  // 원/달러 0.1원(1천 원)짜리도 몇십 계약
  assert.equal(optionLevelQty(1, U.unitValue), 20);
});

test("option ladder: a cheap option's bigger book also gets a bigger inventory limit", () => {
  // 0.1pt: 안쪽 20계약 → 재고 한도 200. 40계약 쓰였어도 매도 호가를 계속 낸다.
  assert.equal(planOptionLadder(K, 10, -OPTION_MM_MAX_INVENTORY).filter((q) => q.side === "SELL").length, 3);
  assert.equal(planOptionLadder(K, 10, -200).filter((q) => q.side === "SELL").length, 0);
});

test("option maker refills a quote that trades down below half of its wanted size", () => {
  const live = (id: string, price: number, qty: number, filledQty = 0) => ({
    id, symbol: "KC21", side: "SELL" as const, type: "LIMIT" as const, price, qty, filledQty, status: "OPEN" as const,
  });
  const desired = [{ side: "SELL" as const, price: 10, qty: 20 }, { side: "SELL" as const, price: 15, qty: 30 }];
  // 10: 예전 2계약 호가 → 다시 건다. 15: 30 중 16 남음 → 둔다.
  const diff = diffOptionLadder(desired, [live("old", 10, 2), live("partial", 15, 30, 14)]);
  assert.deepEqual(diff.cancel.map((order) => order.id), ["old"]);
  assert.deepEqual(diff.place.map((quote) => quote.price), [10]);
});

test("option ladder: deep in-the-money half-spread is capped at 10 ticks", () => {
  // 이론가 50.00pt: 4%면 한쪽 2pt(40호가) → 10호가(0.5pt)로 묶는다
  const quotes = planOptionLadder(K, 5_000, 0);
  assert.equal(Math.max(...quotes.filter((q) => q.side === "BUY").map((q) => q.price)), 4_950);
  assert.equal(Math.min(...quotes.filter((q) => q.side === "SELL").map((q) => q.price)), 5_050);
});

test("option flow finds the option whose last trade drifted furthest from theo", () => {
  const row = (symbol: string, theo: number, lastPrice: number, extra = {}) => ({
    symbol, family: "K", type: "CALL" as const, strike: 105_000, underlying: 110_000, theo, lastPrice, tickUnits: 5, ...extra,
  });
  const rows = [
    row("KC11", 420, 435), // 스프레드 안 — 정상
    row("KC3", 4_500, 3_900), // 깊은 내가격, 6pt 벌어짐
    row("KC6", 2_500, 2_300),
    row("KC21", 5, 60), // 가치 거의 0 — 제외
    row("KCOMC6", 900, 100, { retired: true }),
  ];
  assert.equal(pickStaleOption(rows)?.symbol, "KC3");
  assert.equal(pickStaleOption(rows, new Set(["KC3"]))?.symbol, "KC6");
  assert.equal(pickStaleOption([rows[0], rows[3]]), null);
});

test("option ladder: cheap options never bid below one tick and ask at least two ticks", () => {
  const quotes = planOptionLadder(K, 5, 0);
  assert.ok(quotes.filter((q) => q.side === "BUY").every((q) => q.price >= 5));
  assert.ok(quotes.filter((q) => q.side === "SELL").every((q) => q.price >= 10));
});

test("option ladder: inventory skews the center and a full book stops adding to that side", () => {
  const long = planOptionLadder(U, 100, 20);
  assert.equal(Math.max(...long.filter((q) => q.side === "BUY").map((q) => q.price)), 100 - 2 - 4);
  const maxShort = planOptionLadder(U, 100, -OPTION_MM_MAX_INVENTORY);
  assert.equal(maxShort.filter((q) => q.side === "SELL").length, 0);
  assert.equal(maxShort.filter((q) => q.side === "BUY").length, 3);
});

test("option flow picks at-the-money strikes most often, by distance from the underlying", () => {
  assert.equal(pickStrikeOffset(() => 0.1), 0);
  assert.equal(pickStrikeOffset(() => 0.5), 1);
  assert.equal(pickStrikeOffset(() => 0.99), 5);
  const rows = [9_800, 9_900, 10_000, 10_100, 10_200].flatMap((strike) =>
    (["CALL", "PUT"] as const).map((type) => ({
      symbol: `${type[0]}${strike}`, family: "KCOM", type, strike, underlying: 10_040, theo: 30, lastPrice: 30, tickUnits: 1,
    })),
  );
  assert.equal(pickOptionByOffset(rows, 0, "CALL")?.strike, 10_000);
  assert.equal(pickOptionByOffset(rows, 1, "PUT")?.strike, 10_100);
  assert.equal(pickOptionByOffset(rows, 9, "CALL")?.strike, 10_200); // 끝에서 멈춘다
});

test("far-from-the-money strikes quote fewer levels", () => {
  assert.equal(strikeSteps({ strike: 10_300, underlying: 10_050 }, { strikeStepUnits: 50 }), 5);
  assert.equal(planOptionLadder(U, 100, 0, false, 2).length, 4);
});

test("retired option families only bid, so holders can still sell before expiry", () => {
  const quotes = planOptionLadder(K, 450, -10, true);
  assert.equal(quotes.filter((q) => q.side === "SELL").length, 0);
  assert.equal(quotes.filter((q) => q.side === "BUY").length, 3);
});

test("closing an option position trades the opposite side for the whole quantity", () => {
  assert.deepEqual(closingOrder({ symbol: "KCOMC6", qty: 3 }), { symbol: "KCOMC6", side: "SELL", qty: 3 });
  assert.deepEqual(closingOrder({ symbol: "UP4", qty: -2 }), { symbol: "UP4", side: "BUY", qty: 2 });
  assert.equal(closingOrder({ symbol: "UP4", qty: 0 }), null);
});

test("option flow holds a nearly worthless long to expiry instead of trying to close it", () => {
  // 이론가 1호가: 마켓메이커 매수 호가가 없다 → 닫지 않고 보유 한도에서도 뺀다
  assert.equal(planOptionLadder(U, 1, 0).some((q) => q.side === "BUY"), false);
  assert.equal(heldToExpiry({ qty: 3 }, { theo: 1, tickUnits: 1 }), true);
  // 2호가부터는 1호가 매수 호가가 있어 닫을 수 있다
  assert.equal(planOptionLadder(U, 2, 0).some((q) => q.side === "BUY"), true);
  assert.equal(heldToExpiry({ qty: 3 }, { theo: 2, tickUnits: 1 }), false);
  // 쓴(매도) 포지션은 매도 호가로 되살 수 있고, 시세를 모르면 평소처럼 닫는다
  assert.equal(heldToExpiry({ qty: -3 }, { theo: 1, tickUnits: 1 }), false);
  assert.equal(heldToExpiry({ qty: 3 }, null), false);
});
