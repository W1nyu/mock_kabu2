import assert from "node:assert/strict";
import { test } from "node:test";
import { futureDef } from "@mock-kabu/shared";
import type { LiveOrder } from "../client";
import {
  affordableFuturesQty,
  diffFuturesLadder,
  futuresMomentumSide,
  futuresQuoteCenter,
  futuresRiskMode,
  FuturesMarketView,
  planFuturesLadder,
  reduceOrder,
  FUTURES_LADDER_LEVELS,
} from "../futures-bots";

const KABUF = futureDef("KABUF")!;

test("the quote center sits on a tick and leans against inventory", () => {
  assert.equal(futuresQuoteCenter(KABUF, 88_012, 0), 88_010);
  // 롱 45계약 → 2틱(10단위) 아래로
  assert.equal(futuresQuoteCenter(KABUF, 88_010, 45), 88_000);
  // 기울기는 최대 3틱
  assert.equal(futuresQuoteCenter(KABUF, 88_010, -500), 88_025);
});

test("the ladder has N levels a side on ticks, thin inside and thicker outside", () => {
  const ladder = planFuturesLadder(KABUF, 88_000);
  assert.equal(ladder.length, FUTURES_LADDER_LEVELS * 2);
  const bids = ladder.filter((q) => q.side === "BUY").map((q) => [q.price, q.qty]);
  const asks = ladder.filter((q) => q.side === "SELL").map((q) => [q.price, q.qty]);
  assert.deepEqual(bids[0], [87_995, 4]);
  assert.deepEqual(asks.at(-1), [88_025, 12]);
  assert.ok(ladder.every((q) => q.price % KABUF.tickUnits === 0));
});

test("reconciling keeps matching orders, cancels strays, and only fills gaps", () => {
  const live = (id: string, side: "BUY" | "SELL", price: number): LiveOrder => ({
    id, symbol: "KABUF", side, type: "LIMIT", price, qty: 2, filledQty: 1, status: "PARTIAL",
  });
  const desired = planFuturesLadder(KABUF, 88_000);
  const diff = diffFuturesLadder(desired, [
    live("keep", "BUY", 87_995),
    live("dup", "BUY", 87_995),
    live("stray", "SELL", 88_500),
  ]);
  assert.deepEqual(diff.cancel.map((o) => o.id), ["dup", "stray"]);
  assert.equal(diff.place.length, desired.length - 1);
  assert.ok(!diff.place.some((q) => q.side === "BUY" && q.price === 87_995));
});

test("trading bots only reduce when a margin call is open or equity is under 2x maintenance", () => {
  assert.equal(futuresRiskMode({ positions: [], equity: 1_000, maintenanceMargin: 400, marginCall: null }), "normal");
  assert.equal(futuresRiskMode({ positions: [], equity: 700, maintenanceMargin: 400, marginCall: null }), "reduce");
  assert.equal(futuresRiskMode({ positions: [], equity: 10_000, maintenanceMargin: 400, marginCall: { deadline: "x" } }), "reduce");
  assert.equal(futuresRiskMode({ positions: [] }), "normal");
});

test("reduceOrder shrinks an open position toward zero, never past it", () => {
  const order = reduceOrder([{ symbol: "USDF", qty: 0 }, { symbol: "OILF", qty: -2 }], () => 0.99);
  assert.deepEqual(order, { symbol: "OILF", side: "BUY", qty: 2 });
  assert.equal(reduceOrder([{ symbol: "USDF", qty: 0 }]), null);
});

test("momentum reads the underlying's move over the window against a per-asset threshold", () => {
  const view = new FuturesMarketView({} as never);
  view.record("OILF", 0, 10_000);
  view.record("OILF", 60_000, 10_020);
  view.record("OILF", 100_000, 10_050);
  // 90초 창: t=0(10,000) 대비 +50bps
  assert.equal(Math.round(view.changeBps("OILF", 90_000, 100_000)!), 50);
  assert.equal(futuresMomentumSide(50, 40), "BUY");
  assert.equal(futuresMomentumSide(-45, 40), "SELL");
  assert.equal(futuresMomentumSide(30, 40), null);
  assert.equal(view.changeBps("USDF", 90_000, 100_000), null);
});

test("futures flow only opens what its free cash can margin (bot7 had its cash tied up in stock)", () => {
  const kabuf = futureDef("KABUF")!;
  // 940.00pt × 1.1 × 100원 × 21.75% ≈ 2,249,000원/계약
  assert.equal(affordableFuturesQty(kabuf, 94_000, 6_000_000, 5), 2);
  assert.equal(affordableFuturesQty(kabuf, 94_000, 1_000_000, 5), 0);
  assert.equal(affordableFuturesQty(kabuf, 94_000, 1_000_000_000, 5), 5);
  assert.equal(affordableFuturesQty(kabuf, 94_000, -5, 5), 0);
});
