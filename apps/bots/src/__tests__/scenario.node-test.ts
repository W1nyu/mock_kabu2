import assert from "node:assert/strict";
import { test } from "node:test";
import { SYMBOLS } from "@mock-kabu/shared";
import {
  hiddenEventSentimentFromRoll,
  MarketModel,
  pressuredSentimentFromRoll,
  type RandomSource,
} from "../market-model";
import { NewsScheduler } from "../news/scheduler";
import { RingBufferNewsSink } from "../news/sink";
import type { NewsItem } from "../news/types";
import { scenarioPressure, type PressureScenario } from "../scenario";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function seededRandom(seed: number): RandomSource {
  let state = seed >>> 0;
  return {
    next() {
      state = (state * 1_664_525 + 1_013_904_223) >>> 0;
      return state / 0x1_0000_0000;
    },
  };
}

function scenario(overrides: Partial<PressureScenario> = {}): PressureScenario {
  return {
    id: "s1",
    symbols: ["TANU"],
    direction: "DOWN",
    intensity: 3,
    startsAtMs: 0,
    endsAtMs: 3 * HOUR,
    ...overrides,
  };
}

test("pressure is zero outside the window and on other symbols", () => {
  const list = [scenario({ startsAtMs: HOUR, endsAtMs: 4 * HOUR })];
  assert.equal(scenarioPressure(list, "TANU", HOUR - 1), 0);
  assert.equal(scenarioPressure(list, "TANU", 4 * HOUR), 0);
  assert.equal(scenarioPressure(list, "KABU", 2 * HOUR), 0);
  assert.equal(scenarioPressure(list, "TANU", 2 * HOUR), -1);
});

test("pressure ramps in and out over ten minutes instead of switching", () => {
  const list = [scenario()];
  assert.ok(Math.abs(scenarioPressure(list, "TANU", 5 * MINUTE) + 0.5) < 1e-9);
  assert.equal(scenarioPressure(list, "TANU", 10 * MINUTE), -1);
  assert.ok(Math.abs(scenarioPressure(list, "TANU", 3 * HOUR - 5 * MINUTE) + 0.5) < 1e-9);
});

test("intensity scales pressure, direction signs it, and overlaps clamp", () => {
  const at = HOUR;
  assert.equal(scenarioPressure([scenario({ intensity: 1, direction: "UP" })], "TANU", at), 0.4);
  assert.equal(scenarioPressure([scenario({ intensity: 2 })], "TANU", at), -0.7);
  assert.equal(
    scenarioPressure([scenario({ id: "a" }), scenario({ id: "b", intensity: 2 })], "TANU", at),
    -1,
  );
  assert.equal(
    scenarioPressure([scenario({ id: "a", direction: "UP" }), scenario({ id: "b" })], "TANU", at),
    0,
  );
});

test("zero pressure keeps the ordinary sentiment roll exactly", () => {
  for (let roll = 0; roll < 1; roll += 0.01) {
    assert.equal(pressuredSentimentFromRoll(roll, 0), hiddenEventSentimentFromRoll(roll));
  }
});

test("full downward pressure makes most, but not all, stories bad", () => {
  let negative = 0;
  const samples = 10_000;
  for (let i = 0; i < samples; i++) {
    if (pressuredSentimentFromRoll((i + 0.5) / samples, -1) === "NEGATIVE") negative++;
  }
  const share = negative / samples;
  assert.ok(share > 0.8 && share < 0.9, `negative share ${share}`);
});

test("scenario pressure leans ordinary flow only on its symbols", () => {
  const model = new MarketModel(SYMBOLS, {
    eventSpawnChance: 0,
    scenarioPressure: (symbol) => (symbol === "TANU" ? -1 : 0),
  });
  assert.ok(model.flowBias("TANU") < -0.2);
  assert.equal(model.flowBias("KABU"), 0);
});

function simulate(seed: number, pressure?: (symbol: string, nowMs: number) => number): NewsItem[] {
  const model = new MarketModel(SYMBOLS, { random: seededRandom(seed + 1), eventSpawnChance: 0 });
  const scheduler = new NewsScheduler(model, SYMBOLS, new RingBufferNewsSink(500), {
    random: seededRandom(seed),
    pressure,
  });
  const published: NewsItem[] = [];
  for (let t = 0; t <= 3 * HOUR; t += 5_000) {
    const item = scheduler.tick(t);
    if (item) published.push(item);
    model.tick();
  }
  return published;
}

test("with no scenario the news stream is identical to the unpressured scheduler", () => {
  const plain = simulate(2_026).map((item) => item.id);
  const zero = simulate(2_026, () => 0).map((item) => item.id);
  assert.deepEqual(zero, plain);
});

test("a strong three-hour DOWN scenario brings TANU more, and mostly bad, news", () => {
  const list = [scenario()];
  let baselineTanu = 0;
  let pressuredTanu = 0;
  let pressuredNegative = 0;
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const tanuStories = (items: NewsItem[]) =>
      items.filter((item) => item.scope === "SYMBOL" && item.symbol === "TANU" && !item.parentItemId);
    baselineTanu += tanuStories(simulate(seed)).length;
    const pressured = tanuStories(simulate(seed, (symbol, nowMs) => scenarioPressure(list, symbol, nowMs)));
    pressuredTanu += pressured.length;
    pressuredNegative += pressured.filter((item) => item.impact[0].sentiment === "NEGATIVE").length;
  }
  assert.ok(pressuredTanu >= baselineTanu * 3, `TANU stories ${baselineTanu} → ${pressuredTanu}`);
  assert.ok(
    pressuredNegative / pressuredTanu > 0.65,
    `negative share ${pressuredNegative}/${pressuredTanu}`,
  );
  assert.ok(pressuredNegative < pressuredTanu, "some good news still gets through");
});
