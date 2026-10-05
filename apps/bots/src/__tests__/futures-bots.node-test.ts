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
  futuresLadderStep,
  glideCenter,
  jitteredQty,
  planFuturesLadder,
  reduceOrder,
  withoutSelfCross,
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
  // 880pt에서 한 칸 = 2틱(0.10pt), 7단
  assert.equal(bids[0][0], 87_990);
  assert.equal(asks.at(-1)![0], 88_070);
  // 안쪽 3계약·바깥 9계약 기준 ×0.7~1.3 — 단마다 다르지만 바깥이 대체로 두껍다
  assert.ok(bids[0][1] >= 2 && bids[0][1] <= 4);
  assert.ok(asks.at(-1)![1] >= 6 && asks.at(-1)![1] <= 12);
  // 같은 가격이면 수량도 같다 — 다시 짜도 재접수하지 않는다
  assert.deepEqual(planFuturesLadder(KABUF, 88_000), ladder);
  assert.ok(ladder.every((q) => q.price % KABUF.tickUnits === 0));
});

test("the ladder step is about 1bp in whole ticks, so KABUF's tiny tick widens as the index grows", () => {
  const USDF = futureDef("USDF")!;
  const OILF = futureDef("OILF")!;
  assert.equal(futuresLadderStep(USDF, 14_324), 1);
  assert.equal(futuresLadderStep(OILF, 10_060), 1);
  // 1,288pt → 12.9단위 ≈ 3틱(0.15pt)
  assert.equal(futuresLadderStep(KABUF, 128_800), 15);
  const ladder = planFuturesLadder(KABUF, 128_800);
  assert.deepEqual(
    ladder.filter((q) => q.side === "SELL").map((q) => q.price),
    [128_815, 128_830, 128_845, 128_860, 128_875, 128_890, 128_905],
  );
  assert.ok(ladder.every((q) => q.price % KABUF.tickUnits === 0));
});

test("the market maker's fair value averages out the index's bid/ask bounce", () => {
  const view = new FuturesMarketView({} as never);
  // 운영에서 2초 간격으로 본 KABU 지수: ±1pt씩 튄다
  const samples = [128_763, 128_904, 128_873, 128_869, 128_799, 128_872, 128_682, 128_862, 128_726, 128_772];
  samples.forEach((value, i) => view.record("KABUF", i * 2_000, value));
  const smooth = view.smoothedFair("KABUF", 20_000, 18_000)!;
  assert.ok(Math.abs(smooth - 128_812) < 1);
  // 창 밖 옛 값은 빠진다
  assert.equal(view.smoothedFair("KABUF", 3_000, 18_000), (128_726 + 128_772) / 2);
});

test("reconciling keeps matching orders, cancels strays, and only fills gaps", () => {
  const live = (id: string, side: "BUY" | "SELL", price: number): LiveOrder => ({
    id, symbol: "KABUF", side, type: "LIMIT", price, qty: 2, filledQty: 1, status: "PARTIAL",
  });
  const desired = planFuturesLadder(KABUF, 88_000, KABUF.tickUnits);
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

test("the quote center glides toward its target instead of jumping the whole book", () => {
  // 15단위 칸: 10칸 떨어지면 이번엔 4칸(1/3 올림)만, 가까우면 최대 2칸
  assert.equal(glideCenter(128_800, 128_950, 15), 128_860);
  assert.equal(glideCenter(128_800, 128_830, 15), 128_830);
  assert.equal(glideCenter(128_800, 128_755, 15), 128_770);
  assert.equal(glideCenter(128_800, 128_800, 15), 128_800);
});

test("new quotes never cross the maker's own still-live orders on the other side", () => {
  const live = (side: "BUY" | "SELL", price: number): LiveOrder => ({
    id: `${side}${price}`, symbol: "KABUF", side, type: "LIMIT", price, qty: 3, filledQty: 0, status: "OPEN",
  });
  const quotes = [
    { side: "BUY" as const, price: 100, qty: 1 },
    { side: "BUY" as const, price: 110, qty: 1 },
    { side: "SELL" as const, price: 95, qty: 1 },
    { side: "SELL" as const, price: 120, qty: 1 },
  ];
  // 취소 중인 매도 110·매수 95가 아직 살아 있다
  const kept = withoutSelfCross(quotes, [live("SELL", 110), live("BUY", 95)]);
  assert.deepEqual(kept.map((q) => `${q.side}${q.price}`), ["BUY100", "SELL120"]);
});

test("level sizes vary by price but are stable for the same price", () => {
  assert.equal(jitteredQty(10, "KABUF:B:100"), jitteredQty(10, "KABUF:B:100"));
  const sizes = new Set(Array.from({ length: 20 }, (_, i) => jitteredQty(10, `KABUF:S:${i * 5}`)));
  assert.ok(sizes.size >= 4);
  assert.ok([...sizes].every((qty) => qty >= 7 && qty <= 13));
});
