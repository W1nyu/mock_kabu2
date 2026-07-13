import assert from "node:assert/strict";
import test from "node:test";
import type { SymbolDef } from "@mock-kabu/shared";
import { MarketModel, referencePriceFromHistory } from "../market-model";
import {
  chooseBookLevelIndex,
  chooseMarketTakerQuantity,
  priceScaledShares,
  VolumeActivity,
} from "../volume-activity";

const KABU: SymbolDef = {
  symbol: "KABU",
  name: "테스트",
  initialPrice: 1000,
  tickSize: 10,
};

test("latest matching trade wins over the persisted cache on restart", () => {
  const restored = referencePriceFromHistory(KABU.initialPrice, 1200, 1300);
  const model = new MarketModel([KABU], {
    initialPrices: new Map([[KABU.symbol, restored]]),
    random: { next: () => 0.5 },
  });

  assert.equal(restored, 1300);
  assert.equal(model.get("KABU"), 1300);
});

test("falls back from a missing trade to last_price, then to the initial price", () => {
  assert.equal(referencePriceFromHistory(KABU.initialPrice, 1200, undefined), 1200);
  assert.equal(referencePriceFromHistory(KABU.initialPrice, undefined, undefined), 1000);
  assert.equal(referencePriceFromHistory(KABU.initialPrice, 1200, Number.NaN), 1200);
});

test("a reference tick changes the maker target without an execution-pressure observer", () => {
  const model = new MarketModel([KABU], {
    initialPrices: new Map([[KABU.symbol, 1000]]),
    random: { next: () => 0.5 },
  });

  model.tick();
  assert.ok(Number.isFinite(model.get(KABU.symbol)));
  assert.ok(model.get(KABU.symbol) > 0);
  assert.notEqual(model.get(KABU.symbol), 1000);
});

test("volume activity produces bounded quiet and busy pulses without selecting a trade side", () => {
  const busy = new VolumeActivity([KABU.symbol], {
    // shock, pulse trigger, pulse length, pulse multiplier
    random: sequenceRandom([0.5, 0, 0.99, 0.99, 0.5, 0.5]),
  });
  const busySample = busy.sample(KABU.symbol);

  assert.ok(busySample.intensity > 1.5);
  assert.ok(busySample.intensity <= 2.6);
  assert.ok(busy.quantityFor(busySample, 2, 18, 48) <= 48);

  const quiet = new VolumeActivity([KABU.symbol], {
    // Repeated downward shocks make a thin patch, while the second value
    // suppresses a pulse. The source is deterministic for this regression.
    random: sequenceRandom([0, 0.9]),
  });
  const quietSamples = Array.from({ length: 8 }, () => quiet.sample(KABU.symbol));
  const quietSample = quietSamples.at(-1)!;

  assert.ok(quietSample.intensity <= 0.4);
  assert.ok(quiet.quantityFor(quietSample, 2, 18, 48) >= 2);
  assert.ok(quiet.quantityFor(quietSample, 2, 18, 48) <= 48);

  const pacing = new VolumeActivity([KABU.symbol], { random: { next: () => 0.5 } });
  const activeQty = pacing.quantityFor({ intensity: 2.2 }, 4, 12, 48);
  const quietQty = pacing.quantityFor({ intensity: 0.4 }, 4, 12, 48);
  const wallBoundedQty = pacing.quantityFor({ intensity: 2.6 }, 8, 90, 6);
  const activeDelay = pacing.delayFor({ intensity: 2.2 }, 1_000, 3_000, 400);
  const quietDelay = pacing.delayFor({ intensity: 0.4 }, 1_000, 3_000, 400);
  assert.ok(activeQty > quietQty);
  assert.equal(wallBoundedQty, 6);
  assert.ok(activeDelay < quietDelay);
});

test("flow shares grow for cheap symbols and stochastic takers alternate inside prints with controlled sweeps", () => {
  assert.ok(priceScaledShares(12, 8_000) > priceScaledShares(12, 50_000));
  assert.ok(priceScaledShares(12, 50_000) > priceScaledShares(12, 300_000));

  const inside = chooseMarketTakerQuantity({
    price: 50_000,
    levelQtys: [100, 80, 60],
    minSharesAtReference: 1,
    maxSharesAtReference: 18,
    intensity: 1,
    sweepChance: 0,
    random: () => 0.5,
  });
  assert.equal(inside.sweepsBest, false);
  assert.ok(inside.qty < 100);

  const sweep = chooseMarketTakerQuantity({
    price: 50_000,
    levelQtys: [100, 80, 60],
    minSharesAtReference: 1,
    maxSharesAtReference: 18,
    intensity: 1,
    sweepChance: 1,
    random: () => 0.5,
  });
  assert.equal(sweep.sweepsBest, true);
  assert.ok(sweep.qty > 100);
  assert.ok(sweep.qty <= 240);
});

test("passive book churn chooses non-best visible levels most of the time without excluding the best", () => {
  assert.equal(chooseBookLevelIndex(10, () => 0.1), 0);
  assert.equal(chooseBookLevelIndex(10, () => 0.5), 5);
  assert.equal(chooseBookLevelIndex(10, () => 0.99), 9);
  assert.equal(chooseBookLevelIndex(1, () => 0.9), 0);
});

function sequenceRandom(values: number[]) {
  let index = 0;
  return {
    next: () => {
      const value = values[index % values.length];
      index++;
      return value;
    },
  };
}
