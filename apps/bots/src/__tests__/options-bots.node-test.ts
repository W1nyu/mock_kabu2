import assert from "node:assert/strict";
import { test } from "node:test";
import { OPTION_MM_MAX_INVENTORY, pickOptionSlot, planOptionLadder } from "../options-bots";

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

test("option flow picks at-the-money strikes most often", () => {
  assert.equal(pickOptionSlot(() => 0.1), 3);
  assert.equal(pickOptionSlot(() => 0.95), 5);
});

test("retired option families only bid, so holders can still sell before expiry", () => {
  const quotes = planOptionLadder({ tickUnits: 5 }, 450, -10, true);
  assert.equal(quotes.filter((q) => q.side === "SELL").length, 0);
  assert.equal(quotes.filter((q) => q.side === "BUY").length, 3);
});
