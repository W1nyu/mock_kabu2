import assert from "node:assert/strict";
import test from "node:test";
import {
  applyFutureFill,
  applyFuturesCash,
  futureDef,
  futureMaintenanceMargin,
  futureMarginPerContract,
  futurePositionMargin,
  tickSizeOf,
  TRADABLE_SYMBOLS,
} from "../dist/index.js";

const KABUF = futureDef("KABUF");
const USDF = futureDef("USDF");

test("contract specs: tick, unit value and the 2/3 maintenance rule", () => {
  assert.equal(tickSizeOf("KABUF"), 5);
  assert.equal(tickSizeOf("USDF"), 1);
  assert.ok(TRADABLE_SYMBOLS.includes("OILF") && TRADABLE_SYMBOLS.includes("MOCK"));
  // KABUF 880.00pt, 1계약 = 880 × 10,000원 = 880만 원 → 위탁 21.75% = 1,914,000원
  assert.equal(futureMarginPerContract(KABUF, 88_000), 1_914_000n);
  // USDF 1,400.0원, 1계약 = 1만 달러 = 1,400만 원 → 4.83% = 676,200원
  assert.equal(futureMarginPerContract(USDF, 14_000), 676_200n);
  for (const symbol of ["KABUF", "USDF", "OILF", "GASF", "CPRF"]) {
    const def = futureDef(symbol);
    assert.equal(def.maintenanceMarginBps * 3, def.initialMarginBps * 2, symbol);
  }
  assert.equal(futureMaintenanceMargin(KABUF, -2, 88_000), 2_552_000n);
});

test("opening, adding and partially closing a long", () => {
  let p = applyFutureFill(KABUF, { qty: 0, entryValue: 0n }, "BUY", 88_000, 2);
  assert.deepEqual(p, { qty: 2, entryValue: 176_000n, closedQty: 0, realized: 0n });
  p = applyFutureFill(KABUF, p, "BUY", 88_100, 1);
  assert.deepEqual([p.qty, p.entryValue], [3, 264_100n]);
  // 1계약 청산 @ 885.00pt: 원가 264100/3 = 88033 (내림) → (88500 − 88033) × 100원 = 46,700원
  p = applyFutureFill(KABUF, p, "SELL", 88_500, 1);
  assert.deepEqual(p, { qty: 2, entryValue: 176_067n, closedQty: 1, realized: 46_700n });
});

test("a short profits when price falls, and a flip closes then reopens", () => {
  let p = applyFutureFill(USDF, { qty: 0, entryValue: 0n }, "SELL", 14_000, 1);
  assert.deepEqual([p.qty, p.entryValue], [-1, 14_000n]);
  // 1,400.0 → 1,390.0원에 3계약 매수: 1계약 청산(+100단위 × 1,000원 = 10만 원), 2계약 롱
  p = applyFutureFill(USDF, p, "BUY", 13_900, 3);
  assert.deepEqual(p, { qty: 2, entryValue: 27_800n, closedQty: 1, realized: 100_000n });
});

test("closing everything leaves no residue, and realized + remaining basis is exact", () => {
  let p = { qty: 0, entryValue: 0n };
  let realized = 0n;
  for (const [side, price, qty] of [["BUY", 10_001, 3], ["BUY", 10_007, 4], ["SELL", 10_010, 2], ["SELL", 9_990, 5]]) {
    const next = applyFutureFill(futureDef("OILF"), p, side, price, qty);
    realized += next.realized;
    p = next;
  }
  assert.deepEqual([p.qty, p.entryValue], [0, 0n]);
  const bought = 10_001 * 3 + 10_007 * 4;
  const sold = 10_010 * 2 + 9_990 * 5;
  assert.equal(realized, BigInt(sold - bought) * 500n);
  assert.equal(futurePositionMargin(futureDef("OILF"), 0n), 0n);
});



test("losses never push cash below the order holds; the rest becomes debt, repaid first by gains", () => {
  // 잔액 100만, 주문 묶음 30만 → 현금으로 낼 수 있는 손실 70만
  let s = applyFuturesCash({ balance: 1_000_000n, holdAmount: 300_000n, debt: 0n }, -900_000n);
  assert.deepEqual(s, { balance: 300_000n, debt: 200_000n, ledgerDelta: -700_000n });
  // 이익 50만 → 미수 20만 먼저 갚고 30만만 잔액에
  s = applyFuturesCash({ balance: s.balance, holdAmount: 0n, debt: s.debt }, 500_000n);
  assert.deepEqual(s, { balance: 600_000n, debt: 0n, ledgerDelta: 300_000n });
  // 손익 0은 아무것도 바꾸지 않는다
  assert.deepEqual(applyFuturesCash({ balance: 5n, holdAmount: 1n, debt: 2n }, 0n), { balance: 5n, debt: 2n, ledgerDelta: 0n });
});

import { futuresTradingDay, nextFuturesSettlementAt, futuresSettlementDue } from "../dist/index.js";

test("daily settlement runs at 04:11 KST and is keyed by the KST date", () => {
  // 2026-09-26 04:10:59 KST = 2026-09-25T19:10:59Z
  const justBefore = Date.parse("2026-09-25T19:10:59Z");
  assert.equal(new Date(nextFuturesSettlementAt(justBefore)).toISOString(), "2026-09-25T19:11:00.000Z");
  assert.equal(futuresSettlementDue(justBefore), false);
  const at = Date.parse("2026-09-25T19:11:00Z");
  assert.equal(futuresTradingDay(at), "2026-09-26");
  assert.equal(futuresSettlementDue(at), true);
  // 정산 시각 뒤에는 다음 날 04:11
  assert.equal(new Date(nextFuturesSettlementAt(at)).toISOString(), "2026-09-26T19:11:00.000Z");
});
