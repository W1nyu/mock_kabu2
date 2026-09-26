import assert from "node:assert/strict";
import { test } from "node:test";
import { OPTION_MM_MAX_INVENTORY, pickOptionByOffset, pickStrikeOffset, planOptionLadder, strikeSteps } from "../options-bots";

test("option ladder: 3 levels each side around theo with a 4% half-spread (min 1 tick)", () => {
  // 이론가 50.00pt(5,000단위), 호가 5단위: 한쪽 스프레드 200 → 매수 4,800/4,795/4,790, 매도 5,200/5,205/5,210
  const quotes = planOptionLadder({ tickUnits: 5 }, 5_000, 0);
  assert.deepEqual(
    quotes.filter((q) => q.side === "BUY").map((q) => [q.price, q.qty]),
    [[4_800, 2], [4_795, 3], [4_790, 4]],
  );
  assert.deepEqual(quotes.filter((q) => q.side === "SELL").map((q) => q.price), [5_200, 5_205, 5_210]);
});

test("option ladder: cheap options never bid below one tick and ask at least two ticks", () => {
  const quotes = planOptionLadder({ tickUnits: 5 }, 5, 0);
  assert.ok(quotes.filter((q) => q.side === "BUY").every((q) => q.price >= 5));
  assert.ok(quotes.filter((q) => q.side === "SELL").every((q) => q.price >= 10));
});

test("option ladder: inventory skews the center and a full book stops adding to that side", () => {
  const long = planOptionLadder({ tickUnits: 1 }, 100, 20);
  assert.equal(Math.max(...long.filter((q) => q.side === "BUY").map((q) => q.price)), 100 - 2 - 4);
  const maxShort = planOptionLadder({ tickUnits: 1 }, 100, -OPTION_MM_MAX_INVENTORY);
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
  assert.equal(planOptionLadder({ tickUnits: 1 }, 100, 0, false, 2).length, 4);
});

test("retired option families only bid, so holders can still sell before expiry", () => {
  const quotes = planOptionLadder({ tickUnits: 5 }, 450, -10, true);
  assert.equal(quotes.filter((q) => q.side === "SELL").length, 0);
  assert.equal(quotes.filter((q) => q.side === "BUY").length, 3);
});
