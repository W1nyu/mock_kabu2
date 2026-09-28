import assert from "node:assert/strict";
import test from "node:test";
import {
  atmStrike,
  extendStrikeLadder,
  isOption,
  liquidityReserveBotNumber,
  normCdf,
  optionDef,
  optionFamily,
  optionIntrinsic,
  optionPositionMargin,
  optionTheoretical,
  OPTIONS,
  optionUnderlyingUnits,
  RETIRED_OPTIONS,
  roundPremium,
  strikeForSlot,
  tickSizeOf,
  TRADABLE_SYMBOLS,
} from "../dist/index.js";

test("64 live option series (index × 21 strikes, USD × 11, call/put) plus the retired KCOM options, all tradable", () => {
  assert.equal(OPTIONS.length, 64);
  assert.ok(isOption("KC21") && isOption("KP21") && !isOption("KC22") && isOption("UP11") && !isOption("UP12"));
  assert.deepEqual([...new Set(OPTIONS.map((o) => o.family.code))], ["K", "U"]);
  assert.ok(isOption("KC11") && isOption("UP5") && !isOption("KABUF"));
  assert.equal(optionDef("KC11").name, "주가지수 콜 11");
  assert.equal(optionDef("KC11").family.futures[0], "KABUF");
  assert.ok(!optionDef("KC3").family.retired);
  // 원자재지수 옵션은 거래 종료 — 체결·정산을 위해 정의는 남는다
  assert.equal(RETIRED_OPTIONS.length, 22);
  assert.ok(isOption("KCOMC11") && optionDef("KCOMC3").family.retired);
  assert.ok([...OPTIONS, ...RETIRED_OPTIONS].every((o) => TRADABLE_SYMBOLS.includes(o.symbol)));
  assert.equal(tickSizeOf("KCOMP1"), 1);
  assert.equal(tickSizeOf("KC1"), 5);
  assert.equal(tickSizeOf("UP2"), 1);
  assert.equal(liquidityReserveBotNumber("OPT_KABU"), 41);
  assert.equal(liquidityReserveBotNumber("OPT_USD"), 42);
  assert.equal(liquidityReserveBotNumber("OPT_KCOM"), 43);
});

test("KCOM = equal-weight average of the five commodity values, FX excluded; incomplete basket → null", () => {
  const kcom = optionFamily("KCOM");
  const prices = new Map([
    ["OILF", 10_200], ["GASF", 9_700], ["CPRF", 10_050], ["GOLDF", 10_400], ["CORNF", 9_900], ["USDF", 14_000],
  ]);
  assert.equal(optionUnderlyingUnits(kcom, prices), 10_050); // 100.50pt
  prices.delete("GOLDF");
  assert.equal(optionUnderlyingUnits(kcom, prices), null);
  assert.equal(optionUnderlyingUnits(optionFamily("U"), prices), 14_000);
  assert.equal(atmStrike(kcom, 10_073), 10_050); // 0.5pt 간격
  // 11개 — 6번이 등가격, 등가격 ±5
  assert.deepEqual([1, 6, 11].map((slot) => strikeForSlot(kcom, 10_050, slot)), [9_800, 10_050, 10_300]);
});

test("widening today's ladder keeps existing strikes and adds new ones outside them", () => {
  const kcom = optionFamily("KCOM");
  const existing = [9_950, 10_000, 10_050, 10_100, 10_150];
  const added = extendStrikeLadder(kcom, existing, 6);
  assert.deepEqual([...added].sort((a, b) => a - b), [9_800, 9_850, 9_900, 10_200, 10_250, 10_300]);
  assert.deepEqual(extendStrikeLadder(kcom, [], 3), []);
});

test("strikes center on the rounded underlying, one step apart", () => {
  const k = optionFamily("K");
  const atm = atmStrike(k, 91_640); // 916.40pt → 917.50(2.5pt 간격)
  assert.equal(atm, 91_750);
  // 21개 — 11번이 등가격, 위아래 10개씩(±25pt)
  assert.deepEqual([1, 10, 11, 12, 21].map((slot) => strikeForSlot(k, atm, slot)), [89_250, 91_500, 91_750, 92_000, 94_250]);
  const ladder = Array.from({ length: 21 }, (_, index) => strikeForSlot(k, atm, index + 1));
  assert.equal(ladder.filter((strike) => strike < atm).length, 10);
  assert.equal(ladder.filter((strike) => strike > atm).length, 10);
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
