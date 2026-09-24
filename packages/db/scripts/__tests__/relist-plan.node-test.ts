import assert from "node:assert/strict";
import test from "node:test";
import { indexLevel } from "@mock-kabu/shared";
import { planAddIndexMembers, planRelistIndex } from "../relist-plan";

const shares = new Map([
  ["MOCK", 24_000_000],
  ["KABU", 10_000_000],
  ["TANU", 150_000_000],
  ["SAKU", 4_000_000],
  ["NEKO", 48_000_000],
]);
const initialPrices = new Map([
  ["MOCK", 50_000],
  ["KABU", 120_000],
  ["TANU", 8_000],
  ["SAKU", 300_000],
  ["NEKO", 25_000],
]);
const lastPrices = new Map([
  ["MOCK", 50_350],
  ["KABU", 112_000],
  ["TANU", 6_760],
  ["SAKU", 282_000],
  ["NEKO", 27_200],
]);
const members = [...shares.keys()].sort();
const initialEpoch = { startsAt: 0, divisor: 6_000_000_000_000 / 1000, members };
const plan = planRelistIndex({
  symbol: "KABU",
  listPrice: 120_000,
  baseLevel: 1000,
  epochs: [initialEpoch],
  initialPrices,
  lastPrices,
  shares,
  relistAt: 1_000,
});
const sharesOf = (s: string) => shares.get(s)!;

test("every symbol starts at an equal 1.2조 listing market cap (20% each)", () => {
  for (const [symbol, price] of initialPrices) assert.equal(price * sharesOf(symbol), 1_200_000_000_000);
});

test("history before the relisting excludes the old symbol and still starts at 1,000", () => {
  assert.deepEqual(plan.history[0].members, ["MOCK", "NEKO", "SAKU", "TANU"]);
  assert.equal(indexLevel(plan.history[0], (s) => initialPrices.get(s)!, sharesOf), 1000);
  // 옛 KABU 가격이 얼마였든 과거 지수는 변하지 않는다.
  const withCrashedKabu = new Map(lastPrices).set("KABU", 1);
  assert.equal(
    indexLevel(plan.history[0], (s) => withCrashedKabu.get(s)!, sharesOf),
    indexLevel(plan.history[0], (s) => lastPrices.get(s)!, sharesOf),
  );
});

test("the index level is continuous across the relisting", () => {
  const before = indexLevel(plan.history[0], (s) => lastPrices.get(s)!, sharesOf);
  const afterPrices = new Map(lastPrices).set("KABU", 120_000);
  const after = indexLevel(plan.next, (s) => afterPrices.get(s)!, sharesOf);
  assert.ok(Math.abs(before - after) < 1e-9, `${before} vs ${after}`);
  assert.equal(plan.level, before);
  assert.deepEqual(plan.next.members, members);
  assert.equal(plan.next.startsAt, 1_000);
});

test("a relisted symbol moves the index by its market-cap weight", () => {
  const afterPrices = new Map(lastPrices).set("KABU", 120_000);
  const base = indexLevel(plan.next, (s) => afterPrices.get(s)!, sharesOf);
  afterPrices.set("KABU", 132_000); // +10%
  const moved = indexLevel(plan.next, (s) => afterPrices.get(s)!, sharesOf);
  const cap = [...afterPrices].reduce((sum, [s]) => sum + (s === "KABU" ? 120_000 : lastPrices.get(s)!) * sharesOf(s), 0);
  const weight = (120_000 * sharesOf("KABU")) / cap;
  assert.ok(Math.abs((moved / base - 1) - 0.1 * weight) < 1e-12);
});

test("an index that already has later epochs is refused", () => {
  assert.throws(() =>
    planRelistIndex({
      symbol: "KABU",
      listPrice: 120_000,
      baseLevel: 1000,
      epochs: [initialEpoch, { ...initialEpoch, startsAt: 500 }],
      initialPrices,
      lastPrices,
      shares,
      relistAt: 1_000,
    }),
  );
});

test("new listings join the index without moving it, then count by market-cap weight", () => {
  const withNew = new Map(lastPrices).set("BORI", 4_000).set("DAON", 400_000);
  const newShares = new Map(shares).set("BORI", 300_000_000).set("DAON", 3_000_000);
  const { next, level } = planAddIndexMembers({
    current: plan.next,
    newSymbols: ["BORI", "DAON"],
    lastPrices: withNew,
    shares: newShares,
    at: 2_000,
  });
  const sharesOfNew = (s: string) => newShares.get(s)!;
  assert.ok(Math.abs(indexLevel(next, (s) => withNew.get(s)!, sharesOfNew) - level) < 1e-9);
  assert.deepEqual(next.members, ["BORI", "DAON", "KABU", "MOCK", "NEKO", "SAKU", "TANU"]);
  // 편입 직후 신규 종목 비중 = 상장 시총 ÷ 전체 시총
  const moved = new Map(withNew).set("DAON", 440_000); // +10%
  const cap = [...next.members].reduce((sum, s) => sum + withNew.get(s)! * sharesOfNew(s), 0);
  const weight = (400_000 * 3_000_000) / cap;
  const change = indexLevel(next, (s) => moved.get(s)!, sharesOfNew) / level - 1;
  assert.ok(Math.abs(change - 0.1 * weight) < 1e-12);
  assert.throws(() =>
    planAddIndexMembers({ current: next, newSymbols: ["DAON"], lastPrices: withNew, shares: newShares, at: 3_000 }),
  );
});
