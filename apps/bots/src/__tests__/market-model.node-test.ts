import assert from "node:assert/strict";
import test from "node:test";
import type { SymbolDef } from "@mock-kabu/shared";
import {
  assessSidewaysMarket,
  hiddenEventSentimentFromRoll,
  MarketModel,
  POSITIVE_EVENT_PROBABILITY,
  referencePriceFromHistory,
  sampleHiddenEventProfile,
  SidewaysTracker,
  sidewaysEventSpawnChance,
  sidewaysEventTargetWeight,
} from "../market-model";
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

const MOCK: SymbolDef = {
  symbol: "MOCK",
  name: "다른 테스트",
  initialPrice: 2_000,
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

test("a large durable trade reanchors the quote reference instead of recreating the old wall", () => {
  const model = new MarketModel([KABU], {
    initialPrices: new Map([[KABU.symbol, 120_000]]),
    random: { next: () => 0.5 },
    eventSpawnChance: 0,
  });

  assert.equal(model.observeMarketPrice(KABU.symbol, 132_000, "block-buy"), true);
  assert.equal(model.get(KABU.symbol), 132_000);
  // The same matching row cannot keep reapplying the jump on every poll.
  assert.equal(model.observeMarketPrice(KABU.symbol, 120_000, "block-buy"), false);

  for (let tick = 0; tick < 16; tick++) model.tick();
  // Mean reversion now uses the discovered price as its anchor, so the model
  // cannot immediately drift back to the old 120,000 reference.
  assert.ok(model.get(KABU.symbol) > 128_000);
});

test("good-news events have a slight, fixed probability advantage", () => {
  assert.equal(POSITIVE_EVENT_PROBABILITY, 0.52);
  assert.equal(hiddenEventSentimentFromRoll(0.519), "POSITIVE");
  assert.equal(hiddenEventSentimentFromRoll(0.52), "NEGATIVE");
});

test("hidden events stack their directional flow while keeping other symbols neutral", () => {
  const model = new MarketModel([KABU, MOCK], {
    random: { next: () => 0.5 },
    eventSpawnChance: 0,
  });

  model.startEvent(KABU.symbol, "POSITIVE", 0.45, 0.9);
  assert.equal(model.flowBias(KABU.symbol), 0.45);
  assert.equal(model.flowBias(MOCK.symbol), 0);
  assert.ok(model.flowIntensity(KABU.symbol, 1) > 1);
  assert.equal(model.flowIntensity(MOCK.symbol, 1), 1);

  // A larger adverse event adds a stronger opposite pressure and reverses the
  // actual order-flow preference instead of needing to cancel the first one.
  model.startEvent(KABU.symbol, "NEGATIVE", 0.9, 0.9);
  assert.ok(model.flowBias(KABU.symbol) < 0);
  assert.equal(model.chooseFlowSide(KABU.symbol, "BUY", () => 0), "SELL");
  assert.equal(model.chooseFlowSide(KABU.symbol, "BUY", () => 0.99), "BUY");
});

test("overlapping events retain every active impulse instead of dropping the weakest flow", () => {
  const model = new MarketModel([KABU], { random: { next: () => 0.5 }, eventSpawnChance: 0 });
  for (let index = 0; index < 4; index++) {
    model.startEvent(KABU.symbol, "POSITIVE", 0.2, 0.99);
  }
  model.startEvent(KABU.symbol, "NEGATIVE", 0.2, 0.99);

  // Four positive and one negative impulse remain active: 0.8 - 0.2 = 0.6.
  assert.ok(Math.abs(model.flowBias(KABU.symbol) - 0.6) < 1e-12);
});

test("stronger hidden events persist longer, then return flow to ordinary levels at a new equilibrium", () => {
  const ticksUntilNeutral = (strength: number) => {
    const model = new MarketModel([KABU], {
      random: { next: () => 0.5 },
      eventSpawnChance: 0,
    });
    model.startEvent(KABU.symbol, "POSITIVE", strength);
    let ticks = 0;
    while (model.flowBias(KABU.symbol) !== 0 && ticks < 600) {
      model.tick();
      ticks++;
    }
    assert.equal(model.flowBias(KABU.symbol), 0);
    return ticks;
  };

  assert.ok(ticksUntilNeutral(0.95) > ticksUntilNeutral(0.2));

  const control = new MarketModel([KABU], {
    random: { next: () => 0.5 },
    eventSpawnChance: 0,
  });
  const affected = new MarketModel([KABU], {
    random: { next: () => 0.5 },
    eventSpawnChance: 0,
  });
  affected.startEvent(KABU.symbol, "POSITIVE", 0.8, 0.5);
  for (let tick = 0; tick < 20; tick++) {
    control.tick();
    affected.tick();
  }

  assert.equal(affected.flowBias(KABU.symbol), 0);
  assert.equal(affected.flowIntensity(KABU.symbol, 1), 1);
  // The directional pressure is gone, but the permanent revaluation leaves a
  // newly discovered equilibrium rather than restoring the pre-event price.
  assert.ok(affected.get(KABU.symbol) > control.get(KABU.symbol));
});

test("the stochastic generator can start a hidden event without exposing it", () => {
  const model = new MarketModel([KABU], {
    random: { next: () => 0.75 },
    eventSpawnChance: 1,
  });

  model.tick();
  // With the deterministic source, 0.75 picks a negative event. The model
  // exposes only its simulated flow decision, never an event payload.
  assert.ok(model.flowBias(KABU.symbol) < 0);
});

test("a balanced box range is distinguished from directional or one-sided movement", () => {
  const repeat = (values: number[], count: number) =>
    Array.from({ length: count }, (_, index) => values[index % values.length]);
  const boxed = repeat([100, 102.5, 98, 101.5, 97.5, 102, 99], 96);
  const upwardTrend = Array.from({ length: 96 }, (_, index) => 100 + index * 0.18);
  const risingZigzag = Array.from({ length: 96 }, (_, index) => 100 + index * 0.1 + (index % 2 ? 1.5 : -1));

  assert.ok(assessSidewaysMarket(boxed, 100).score > 0.6);
  assert.equal(assessSidewaysMarket(upwardTrend, 100).score, 0);
  assert.equal(assessSidewaysMarket(risingZigzag, 100).score, 0);
});

test("sideways tracking rebases only after an event has settled at its new equilibrium", () => {
  const tracker = new SidewaysTracker(100);
  const initialBox = Array.from({ length: 96 }, (_, index) => [100, 102, 98, 101, 99][index % 5]);
  for (const price of initialBox) tracker.observe(price, false);
  assert.ok(tracker.assessment().score > 0.6);

  tracker.markEventStarted();
  for (let tick = 0; tick < 39; tick++) tracker.observe(104, false);
  assert.equal(tracker.assessment().score, 0);

  tracker.observe(104, false);
  const revaluedBox = Array.from({ length: 96 }, (_, index) => [104, 107, 101, 106, 102][index % 5]);
  for (const price of revaluedBox) tracker.observe(price, false);
  assert.ok(tracker.assessment().score > 0.6);
  assert.equal(assessSidewaysMarket(revaluedBox, 100).score, 0);
});

test("a durable startup box can establish the initial fixed range baseline without hardcoding a ticker", () => {
  const tracker = new SidewaysTracker(100);
  const currentBox = Array.from({ length: 96 }, (_, index) => [104, 107, 101, 106, 102][index % 5]);
  tracker.seed(currentBox);

  assert.equal(assessSidewaysMarket(currentBox, 100).score, 0);
  assert.ok(tracker.assessment().score > 0.6);
});

test("startup can select a confirmed current box while an older directional leg remains in history", () => {
  const tracker = new SidewaysTracker(100);
  const olderDirection = Array.from({ length: 40 }, (_, index) => 112 - index * 0.3);
  const currentBox = Array.from({ length: 96 }, (_, index) => [104, 107, 101, 106, 102][index % 5]);
  tracker.seed([...olderDirection, ...currentBox]);

  assert.ok(tracker.assessment().score > 0.6);
});

test("a rising channel cannot silently reset the fixed baseline into a sideways box", () => {
  const tracker = new SidewaysTracker(100);
  const risingChannel = Array.from(
    { length: 96 },
    (_, index) => 100 + index * 0.011 + (index % 2 ? 1.5 : -1.5),
  );
  tracker.seed(risingChannel);

  assert.equal(tracker.assessment().score, 0);
});

test("a wide but gently rising channel is not mistaken for a box", () => {
  const tracker = new SidewaysTracker(100);
  const gentleRisingChannel = Array.from(
    { length: 96 },
    (_, index) => 100 + index * 0.004 + (index % 2 ? 2 : -2),
  );
  tracker.seed(gentleRisingChannel);

  assert.equal(tracker.assessment().score, 0);
});

test("faster center reversion makes an otherwise balanced box more sideways", () => {
  const repeat = (values: number[], count = 96) =>
    Array.from({ length: count }, (_, index) => values[index % values.length]);
  const gradualReturn = repeat([100, 101, 102, 102, 101, 100, 99, 98, 98, 99]);
  const briskReturn = repeat([100, 102, 98, 102, 98, 100]);
  const gradual = assessSidewaysMarket(gradualReturn, 100);
  const brisk = assessSidewaysMarket(briskReturn, 100);

  assert.ok(gradual.score > 0.6);
  assert.ok(brisk.score > gradual.score);
  assert.ok(brisk.centerCrossings > gradual.centerCrossings);
  assert.ok(brisk.meanReversion > gradual.meanReversion);
});

test("only durable market observations seed or advance the sideways detector", () => {
  const syntheticOnly = new MarketModel([KABU], {
    random: { next: () => 0.5 },
    eventSpawnChance: 0,
  });
  for (let tick = 0; tick < 160; tick++) syntheticOnly.tick();
  assert.equal(syntheticOnly.sidewaysScore(KABU.symbol), 0);

  const model = new MarketModel([KABU], { random: { next: () => 0.5 }, eventSpawnChance: 0 });
  const durableBox = Array.from({ length: 96 }, (_, index) => [100, 102.5, 98, 101.5, 97.5][index % 5]);
  assert.equal(model.seedMarketHistory(KABU.symbol, durableBox), true);
  assert.ok(model.sidewaysScore(KABU.symbol) > 0.6);
});

test("repeated polling of the same trade id cannot manufacture a sideways range", () => {
  const model = new MarketModel([KABU], { random: { next: () => 0.5 }, eventSpawnChance: 0 });
  const box = Array.from({ length: 96 }, (_, index) => [1000, 1025, 980, 1015, 975, 1020, 990][index % 7]);

  for (const price of box) model.observeMarketPrice(KABU.symbol, price, "same-trade");
  assert.equal(model.sidewaysScore(KABU.symbol), 0);

  for (const [index, price] of box.entries()) {
    assert.equal(model.observeMarketPrice(KABU.symbol, price, `trade-${index}`), true);
  }
  assert.ok(model.sidewaysScore(KABU.symbol) > 0.6);
});

test("pre-event history cannot be reseeded during an event and the post-event baseline waits for a durable price", () => {
  const model = new MarketModel([KABU], { random: { next: () => 0.5 }, eventSpawnChance: 0 });
  const initialBox = Array.from({ length: 96 }, (_, index) => [100, 102, 98, 101, 99][index % 5]);
  assert.equal(model.seedMarketHistory(KABU.symbol, initialBox), true);
  assert.ok(model.sidewaysScore(KABU.symbol) > 0.6);

  model.startEvent(KABU.symbol, "POSITIVE", 0.2, 0.5);
  assert.equal(model.seedMarketHistory(KABU.symbol, initialBox), false);
  assert.equal(model.sidewaysScore(KABU.symbol), 0);

  // Let the event fade and its quiet timer elapse. tick() advances time only;
  // the new equilibrium is established by the following durable price.
  for (let tick = 0; tick < 50; tick++) model.tick();
  const revaluedBox = Array.from({ length: 96 }, (_, index) => [104, 107, 101, 106, 102][index % 5]);
  model.observeMarketPrice(KABU.symbol, 104, "settled-price");
  for (const [index, price] of revaluedBox.entries()) {
    model.observeMarketPrice(KABU.symbol, price, `settled-${index}`);
  }

  assert.equal(assessSidewaysMarket(revaluedBox, 100).score, 0);
  assert.ok(model.sidewaysScore(KABU.symbol) > 0.6);
});

test("sideways conditions raise event likelihood, strength, duration, and volume-burst chance", () => {
  const ordinary = sampleHiddenEventProfile(0, { next: () => 0.5 });
  const sideways = sampleHiddenEventProfile(1, { next: () => 0.5 });

  assert.ok(sidewaysEventSpawnChance(0.004, 1) > sidewaysEventSpawnChance(0.004, 0));
  assert.ok(sidewaysEventTargetWeight(1) > sidewaysEventTargetWeight(0));
  assert.ok(sideways.strength > ordinary.strength);
  assert.ok(sideways.persistence > ordinary.persistence);
  assert.ok(sideways.volumeBurstChance > ordinary.volumeBurstChance);
  assert.ok(sideways.volumeMultiplier > ordinary.volumeMultiplier);
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
