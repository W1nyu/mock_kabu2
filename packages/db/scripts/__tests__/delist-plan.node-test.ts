import assert from "node:assert/strict";
import { test } from "node:test";
import { indexLevel } from "@mock-kabu/shared";
import { delistPayout, planRemoveIndexMembers } from "../delist-plan";

test("a holder in profit is paid at the last price", () => {
  // 10주 평단 50,000 → 현재가 56,000
  const p = delistPayout({ qty: 10, costBasis: 500_000n, lastPrice: 56_000 });
  assert.deepEqual(p, { payout: 560_000n, price: 56_000, realized: 60_000n, rule: "LAST_PRICE" });
});

test("a holder at a loss is paid back at the average cost, sub-won rounded up so no one gets less than cost", () => {
  // 3주 원가 100,000(평단 33,333.3) → 현재가 30,000: 평단 33,334 × 3 = 100,002
  const p = delistPayout({ qty: 3, costBasis: 100_000n, lastPrice: 30_000 });
  assert.deepEqual(p, { payout: 100_002n, price: 33_334, realized: 2n, rule: "AVG_COST" });
  // 운영 사례: 1,472주 원가 9,994,640(평단 6,789.8) → 6,790 × 1,472 = 9,994,880
  assert.equal(delistPayout({ qty: 1_472, costBasis: 9_994_640n, lastPrice: 6_740 }).payout, 9_994_880n);
  // price × qty − costBasis = realized (정합성 검사의 식)
  assert.equal(BigInt(p.price) * 3n - 100_000n, p.realized);
  assert.ok(p.payout >= 100_000n);
});

test("break-even counts as profit (last price)", () => {
  assert.equal(delistPayout({ qty: 4, costBasis: 40_000n, lastPrice: 10_000 }).rule, "LAST_PRICE");
});

test("removing members keeps the index level continuous", () => {
  const current = { startsAt: 0, divisor: 1_000, members: ["A", "B", "C"] };
  const prices = new Map([["A", 100], ["B", 200], ["C", 300]]);
  const shares = new Map([["A", 10], ["B", 10], ["C", 10]]);
  const plan = planRemoveIndexMembers({ current, removed: ["B", "Z"], lastPrices: prices, shares, at: 10 })!;
  assert.deepEqual(plan.next.members, ["A", "C"]);
  const before = indexLevel(current, (s) => prices.get(s)!, (s) => shares.get(s)!);
  const after = indexLevel(plan.next, (s) => prices.get(s)!, (s) => shares.get(s)!);
  assert.ok(Math.abs(before - after) < 1e-9, `${before} vs ${after}`);
  assert.equal(planRemoveIndexMembers({ current: plan.next, removed: ["B"], lastPrices: prices, shares, at: 20 }), null);
});
