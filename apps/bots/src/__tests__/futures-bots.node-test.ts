import assert from "node:assert/strict";
import { test } from "node:test";
import { futureDef } from "@mock-kabu/shared";
import type { LiveOrder } from "../client";
import { diffFuturesLadder, futuresQuoteCenter, planFuturesLadder, FUTURES_LADDER_LEVELS } from "../futures-bots";

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
  assert.deepEqual(bids[0], [87_995, 2]);
  assert.deepEqual(asks.at(-1), [88_025, 6]);
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
