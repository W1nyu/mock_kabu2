import assert from "node:assert/strict";
import test from "node:test";
import {
  atmStrike,
  isOption,
  liquidityReserveBotNumber,
  normCdf,
  optionDef,
  optionFamily,
  optionIntrinsic,
  optionPositionMargin,
  optionTheoretical,
  OPTIONS,
  roundPremium,
  strikeForSlot,
  tickSizeOf,
  TRADABLE_SYMBOLS,
} from "../dist/index.js";

test("20 option series: 2 underlyings × call/put × 5 strikes, all tradable", () => {
  assert.equal(OPTIONS.length, 20);
  assert.ok(isOption("KC3") && isOption("UP5") && !isOption("KABUF"));
  assert.ok(OPTIONS.every((o) => TRADABLE_SYMBOLS.includes(o.symbol)));
  assert.equal(optionDef("KC3").name, "주가지수 콜 3");
  assert.equal(tickSizeOf("KC1"), 5);
  assert.equal(tickSizeOf("UP2"), 1);
  assert.equal(liquidityReserveBotNumber("OPT_KABU"), 41);
  assert.equal(liquidityReserveBotNumber("OPT_USD"), 42);
});

test("strikes center on the rounded underlying, one step apart", () => {
  const k = optionFamily("K");
  const atm = atmStrike(k, 91_640); // 916.40pt → 920.00
  assert.equal(atm, 92_000);
  assert.deepEqual([1, 2, 3, 4, 5].map((slot) => strikeForSlot(k, atm, slot)), [90_000, 91_000, 92_000, 93_000, 94_000]);
  const u = optionFamily("U");
  assert.equal(atmStrike(u, 14_023), 14_000); // 1,402.3원 → 1,400원
});

test("Black–Scholes: put–call parity, intrinsic at expiry, sensible ATM premium", () => {
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-7);
  assert.ok(Math.abs(normCdf(1.96) - 0.975) < 1e-3);
  const base = { underlying: 91_640, strike: 92_000, days: 1, dailyVol: 0.012 };
  const call = optionTheoretical({ ...base, type: "CALL" });
  const put = optionTheoretical({ ...base, type: "PUT" });
  assert.ok(Math.abs(call - put - (91_640 - 92_000)) < 1e-6, "C − P = S − K");
  // 등가격 하루 옵션 ≈ 0.4 × σ × S ≈ 440 단위(4.4pt)
  const atmCall = optionTheoretical({ ...base, strike: 91_640, type: "CALL" });
  assert.ok(atmCall > 400 && atmCall < 470, `${atmCall}`);
  assert.equal(optionTheoretical({ ...base, days: 0, type: "CALL" }), 0);
  assert.equal(optionTheoretical({ ...base, days: 0, type: "PUT" }), 360);
  assert.equal(optionIntrinsic("CALL", 93_000, 92_000), 1_000);
  assert.equal(roundPremium(optionDef("KC3"), 437), 435);
  assert.equal(roundPremium(optionDef("KC3"), 1), 5);
});

test("only written (short) positions hold margin: strike notional × rate", () => {
  const kc = optionDef("KC3");
  // 920.00pt 행사가 × 100원 × 8% = 736,000원/계약
  assert.equal(optionPositionMargin(kc, -2, 92_000), 1_472_000n);
  assert.equal(optionPositionMargin(kc, 3, 92_000), 0n);
  // 1,400원 × 1,000원 × 3% = 420,000원/계약
  assert.equal(optionPositionMargin(optionDef("UC3"), -1, 14_000), 420_000n);
});
