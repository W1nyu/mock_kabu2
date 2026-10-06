import assert from "node:assert/strict";
import { test } from "node:test";
import { SYMBOLS } from "@mock-kabu/shared";
import {
  fairIndex,
  BULL_DURATION_EFFECTIVE_AT_MS,
  MARKET_CYCLE_EPOCH_MS,
  MarketCycle,
  MarketMoodSource,
  marketIndexFrom,
  marketSensitivity,
  parseSidewaysWindow,
  symbolLean,
  valuationPull,
  type MarketMood,
} from "../market-cycle";
import { MarketModel, positiveNewsProbability, type RandomSource } from "../market-model";
import { COMPANY_PROFILES } from "../news/company-profiles";
import { NewsScheduler } from "../news/scheduler";
import { RingBufferNewsSink } from "../news/sink";
import type { NewsItem } from "../news/types";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function seededRandom(seed: number): RandomSource {
  let state = seed >>> 0;
  return {
    next() {
      state = (state * 1_664_525 + 1_013_904_223) >>> 0;
      return state / 0x1_0000_0000;
    },
  };
}

function mood(overrides: Partial<MarketMood> = {}): MarketMood {
  return {
    phase: "SIDEWAYS",
    marketLean: 0,
    channelLean: { RATE: 0, FX: 0, OIL: 0, COMMODITY: 0, GLOBAL: 0 },
    volatility: 1,
    newsActivity: 1,
    ...overrides,
  };
}

/** Samples the market phase every ten minutes for `days` across several secrets. */
function sampleSchedules(secrets: number, days: number) {
  const share = { BULL: 0, BEAR: 0, SIDEWAYS: 0 };
  const runs = { BULL: [] as number[], BEAR: [] as number[], SIDEWAYS: [] as number[] };
  const leanByPhase = { BULL: [] as number[], BEAR: [] as number[], SIDEWAYS: [] as number[] };
  const intoBearByRate = { RISING: [0, 0], FALLING: [0, 0], STEADY: [0, 0] };
  let maxStep = 0;
  for (let secret = 0; secret < secrets; secret++) {
    const cycle = new MarketCycle(`secret-${secret}`);
    let previous: ReturnType<MarketCycle["snapshot"]> | null = null;
    for (let t = MARKET_CYCLE_EPOCH_MS; t < MARKET_CYCLE_EPOCH_MS + days * DAY; t += 10 * MINUTE) {
      const snapshot = cycle.snapshot(t);
      share[snapshot.market.phase]++;
      leanByPhase[snapshot.market.phase].push(snapshot.market.lean);
      if (previous) {
        maxStep = Math.max(maxStep, Math.abs(snapshot.market.lean - previous.market.lean));
        if (previous.market.sinceMs !== snapshot.market.sinceMs) {
          runs[previous.market.phase].push(snapshot.market.sinceMs - previous.market.sinceMs);
          const counts = intoBearByRate[snapshot.drivers.RATE.phase];
          counts[1]++;
          if (snapshot.market.phase === "BEAR") counts[0]++;
        }
      }
      previous = snapshot;
    }
  }
  return { share, runs, leanByPhase, intoBearByRate, maxStep };
}

const average = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

test("the duration change preserves an ongoing bull phase and its end after restart", () => {
  // Captured from the previous 32-hour implementation, before changing the rule.
  const secret = "duration-history-0";
  const oldStart = 1_791_150_151_207;
  const oldEnd = 1_791_245_999_882;
  const cycle = new MarketCycle(secret);
  const current = cycle.snapshot(BULL_DURATION_EFFECTIVE_AT_MS).market;
  assert.equal(current.phase, "BULL");
  assert.equal(current.sinceMs, oldStart);
  assert.equal(current.lean, 0.4551823368802461);
  assert.equal(cycle.snapshot(oldEnd - 1).market.sinceMs, oldStart);
  assert.deepEqual(new MarketCycle(secret).snapshot(oldEnd - 1), cycle.snapshot(oldEnd - 1));
  assert.equal(cycle.snapshot(oldEnd).market.sinceMs, oldEnd);
  assert.notEqual(cycle.snapshot(oldEnd).market.phase, "BULL");
});

test("a sideways window preserves macro schedules and starts a new schedule that survives restart", () => {
  const startsAtMs = MARKET_CYCLE_EPOCH_MS + 2 * DAY;
  const endsAtMs = startsAtMs + 12 * HOUR;
  const window = parseSidewaysWindow(`${new Date(startsAtMs).toISOString()},${new Date(endsAtMs).toISOString()}`);
  const automatic = new MarketCycle("override-secret");
  const forced = new MarketCycle("override-secret", undefined, window);
  for (const t of [startsAtMs - DAY, startsAtMs - 1]) {
    assert.deepEqual(forced.snapshot(t), automatic.snapshot(t));
  }
  for (let t = startsAtMs + 10 * MINUTE; t <= endsAtMs - 10 * MINUTE; t += MINUTE) {
    const snapshot = forced.snapshot(t);
    assert.equal(snapshot.market.phase, "SIDEWAYS");
    assert.ok(Math.abs(snapshot.market.lean) <= 0.210001);
    assert.equal(snapshot.market.volatility, 0.88);
    assert.ok(Math.abs(snapshot.market.newsActivity - 0.85) < 1e-9);
    assert.deepEqual(snapshot.drivers, automatic.snapshot(t).drivers);
  }
  const middle = startsAtMs + 6 * HOUR;
  assert.deepEqual(new MarketCycle("override-secret", undefined, window).snapshot(middle), forced.snapshot(middle));
  assert.ok(Math.abs(forced.snapshot(startsAtMs).market.lean - automatic.snapshot(startsAtMs).market.lean) < 1e-9);
  const next = forced.snapshot(endsAtMs);
  assert.ok(["BULL", "BEAR", "SIDEWAYS"].includes(next.market.phase));
  assert.equal(next.market.sinceMs, endsAtMs);
  assert.ok(Math.abs(forced.snapshot(endsAtMs - 1).market.lean - next.market.lean) < 0.001);
  assert.notDeepEqual(forced.snapshot(endsAtMs + DAY).market, automatic.snapshot(endsAtMs + DAY).market);
  assert.deepEqual(new MarketCycle("override-secret", undefined, window).snapshot(endsAtMs + DAY), forced.snapshot(endsAtMs + DAY));
  const nextPhases = new Set(Array.from({ length: 24 }, (_, n) => new MarketCycle(`secret-${n}`, undefined, window).snapshot(endsAtMs).market.phase));
  assert.deepEqual(nextPhases, new Set(["BULL", "BEAR", "SIDEWAYS"]));
});

test("sideways window rejects malformed, reversed, short and unbounded times", () => {
  assert.equal(parseSidewaysWindow(undefined), undefined);
  assert.equal(parseSidewaysWindow(""), undefined);
  const start = "2026-10-03T12:00:00Z";
  for (const input of ["bad", `${start},bad`, `${start},${start}`, `${start},2026-10-03T12:04:00Z`, `${start},2026-10-04T12:01:00Z`, `${start},2026-10-03T13:00:00Z,extra`]) {
    assert.throws(() => parseSidewaysWindow(input), /MARKET_SIDEWAYS_WINDOW/);
  }
});

test("only the first transition after the manual window draws all three phases equally", () => {
  const startsAtMs = MARKET_CYCLE_EPOCH_MS + 2 * DAY;
  const endsAtMs = startsAtMs + 12 * HOUR;
  const window = { startsAtMs, endsAtMs };
  const counts = { BULL: 0, BEAR: 0, SIDEWAYS: 0 };
  for (let seed = 0; seed < 3000; seed++) {
    const cycle = new MarketCycle(`equal-${seed}`, undefined, window);
    counts[cycle.snapshot(endsAtMs).market.phase]++;
  }
  for (const count of Object.values(counts)) assert.ok(Math.abs(count / 3000 - 1 / 3) < 0.03);
  // Once the special draw has happened, the existing rule forbids repeating a phase.
  const cycle = new MarketCycle("later-rules", undefined, window);
  let previous = cycle.snapshot(endsAtMs).market;
  for (let t = endsAtMs + 10 * MINUTE; t < endsAtMs + 30 * DAY; t += 10 * MINUTE) {
    const current = cycle.snapshot(t).market;
    if (current.sinceMs !== previous.sinceMs) assert.notEqual(current.phase, previous.phase);
    previous = current;
  }
});

test("the same secret gives the same phases whatever order they are asked in", () => {
  const forward = new MarketCycle("prod-secret");
  const backward = new MarketCycle("prod-secret");
  const times = Array.from({ length: 200 }, (_, index) => MARKET_CYCLE_EPOCH_MS + index * 7 * HOUR);
  const later = [...times].reverse().map((t) => backward.snapshot(t));
  assert.deepEqual(
    times.map((t) => forward.snapshot(t)),
    later.reverse(),
  );
});

test("a different secret gives a different schedule", () => {
  const a = new MarketCycle("one");
  const b = new MarketCycle("two");
  const phases = (cycle: MarketCycle) =>
    Array.from({ length: 60 }, (_, day) => cycle.snapshot(MARKET_CYCLE_EPOCH_MS + day * DAY).market.phase).join();
  assert.notEqual(phases(a), phases(b));
});

test("bull, bear and range-bound markets all come round, bulls lasting longer than bears", () => {
  const { share, runs, leanByPhase } = sampleSchedules(12, 90);
  const total = share.BULL + share.BEAR + share.SIDEWAYS;
  assert.ok(share.BULL / total > 0.35 && share.BULL / total < 0.55, `bull share ${share.BULL / total}`);
  assert.ok(share.BEAR / total > 0.2 && share.BEAR / total < 0.4, `bear share ${share.BEAR / total}`);
  assert.ok(share.SIDEWAYS / total > 0.15, `range share ${share.SIDEWAYS / total}`);
  assert.ok(average(runs.BULL) > average(runs.BEAR), "a bull market outlasts a bear market on average");
  assert.ok(average(runs.BEAR) >= 8 * HOUR && average(runs.BULL) <= 36 * HOUR);
  assert.ok(runs.BULL.every((duration) => duration >= 12 * HOUR && duration <= 36 * HOUR));
  assert.ok(runs.BULL.some((duration) => duration > 32 * HOUR), "bull markets can now last beyond 32 hours");
  assert.ok(runs.BEAR.every((duration) => duration >= 8 * HOUR && duration <= 24 * HOUR));
  assert.ok(runs.BEAR.some((duration) => duration > 22 * HOUR), "bear markets can now last beyond 22 hours");
  assert.ok(runs.SIDEWAYS.every((duration) => duration >= 6 * HOUR && duration <= 18 * HOUR));
  assert.ok(average(leanByPhase.BULL) > 0.25, `bull lean ${average(leanByPhase.BULL)}`);
  assert.ok(average(leanByPhase.BEAR) < -0.3, `bear lean ${average(leanByPhase.BEAR)}`);
  assert.ok(Math.abs(average(leanByPhase.SIDEWAYS)) < 0.08, `range lean ${average(leanByPhase.SIDEWAYS)}`);
});

test("the lean stays bounded and eases from one phase into the next", () => {
  const { leanByPhase, maxStep } = sampleSchedules(6, 60);
  for (const values of Object.values(leanByPhase)) {
    for (const lean of values) assert.ok(Math.abs(lean) <= 1);
  }
  // Even a bear-to-bull turn takes ninety minutes, never one ten-minute step.
  assert.ok(maxStep < 0.3, `largest ten-minute step ${maxStep}`);
});

test("a hiking cycle makes the next turn more likely to be a bear market than an easing cycle does", () => {
  const { intoBearByRate } = sampleSchedules(30, 90);
  const rising = intoBearByRate.RISING[0] / intoBearByRate.RISING[1];
  const falling = intoBearByRate.FALLING[0] / intoBearByRate.FALLING[1];
  assert.ok(rising > falling + 0.05, `into bear: hiking ${rising}, easing ${falling}`);
});

test("the report carries the current phases but never when they end", () => {
  const source = new MarketMoodSource(new MarketCycle("report"));
  source.observeIndex(1_250);
  const now = MARKET_CYCLE_EPOCH_MS + 3 * DAY;
  const report = source.report(now);
  assert.equal(report.reportedAtMs, now);
  assert.ok(report.market.sinceMs <= now);
  assert.ok(Math.abs(report.market.positiveShare - positiveNewsProbability(report.market.lean)) < 0.002);
  assert.ok(report.valuation.pull < 0, "an index well above fair value pulls the lean down");
  assert.ok(!JSON.stringify(report).includes("end"), "no end time leaks into the report");
});

test("valuation pulls against an index far from fair value, capped and off until the index is known", () => {
  const now = MARKET_CYCLE_EPOCH_MS + 10 * DAY;
  const fair = fairIndex(now);
  assert.equal(valuationPull(null, now), 0);
  assert.ok(Math.abs(valuationPull(fair, now)) < 1e-9);
  assert.ok(valuationPull(fair * 1.1, now) < -0.09 && valuationPull(fair * 1.1, now) > -0.1);
  assert.ok(valuationPull(fair * 0.9, now) > 0.1);
  assert.equal(valuationPull(fair * 3, now), -0.3);
  assert.equal(valuationPull(fair / 3, now), 0.3);
  assert.ok(fairIndex(now + 100 * DAY) > fair, "fair value grows slowly over time");
});

test("defensive listings ride the cycle less than high-beta ones", () => {
  const listed = COMPANY_PROFILES.filter((profile) => SYMBOLS.some((symbol) => symbol.symbol === profile.symbol));
  const byBeta = [...listed].sort((a, b) => a.macroBeta.GLOBAL - b.macroBeta.GLOBAL);
  const defensive = byBeta[0].symbol;
  const cyclical = byBeta[byBeta.length - 1].symbol;
  assert.ok(marketSensitivity(defensive) < marketSensitivity(cyclical));
  const bull = mood({ phase: "BULL", marketLean: 0.4 });
  assert.ok(symbolLean(bull, defensive) > 0 && symbolLean(bull, defensive) < symbolLean(bull, cyclical));
});

test("the market index is cap-weighted over the members and unknown until every price is", () => {
  const meta = { divisor: 1_000, members: [{ symbol: "A", listedShares: 10 }, { symbol: "B", listedShares: 30 }] };
  assert.equal(marketIndexFrom(meta, (symbol) => (symbol === "A" ? 100 : 50)), (100 * 10 + 50 * 30) / 1_000);
  assert.equal(marketIndexFrom(meta, (symbol) => (symbol === "A" ? 100 : null)), null);
  assert.equal(marketIndexFrom({ divisor: 0, members: meta.members }, () => 1), null);
});

function runNews(newsMood: MarketMood | undefined, hours: number, seed = 7): NewsItem[] {
  const model = new MarketModel(SYMBOLS, { random: seededRandom(seed + 1), eventSpawnChance: 0 });
  const sink = new RingBufferNewsSink(10_000);
  const scheduler = new NewsScheduler(model, SYMBOLS, sink, {
    random: seededRandom(seed),
    ...(newsMood ? { mood: () => newsMood } : {}),
  });
  const items: NewsItem[] = [];
  for (let t = 0; t < hours * HOUR; t += 5_000) {
    const item = scheduler.tick(t);
    if (item) items.push(item);
  }
  return items;
}

function goodShare(items: readonly NewsItem[], scope: NewsItem["scope"]): number {
  const impacts = items.filter((item) => item.scope === scope).flatMap((item) => item.impact);
  return impacts.filter((impact) => impact.sentiment === "POSITIVE").length / impacts.length;
}

test("a neutral mood leaves the news stream exactly as it was", () => {
  const strip = (items: readonly NewsItem[]) => items.map((item) => [item.id, item.headline, item.impact]);
  assert.deepEqual(strip(runNews(mood(), 12)), strip(runNews(undefined, 12)));
});

test("a bull market brings mostly good news and a bear market mostly bad", () => {
  const bull = runNews(mood({ phase: "BULL", marketLean: 0.4 }), 72);
  const bear = runNews(mood({ phase: "BEAR", marketLean: -0.45, volatility: 1.12, newsActivity: 1.2 }), 72);
  for (const scope of ["SYMBOL", "SECTOR", "MACRO"] as const) {
    assert.ok(goodShare(bull, scope) > 0.56, `bull ${scope} ${goodShare(bull, scope)}`);
    assert.ok(goodShare(bear, scope) < 0.44, `bear ${scope} ${goodShare(bear, scope)}`);
  }
  // Neither ever becomes one-sided.
  assert.ok(goodShare(bull, "SYMBOL") < 0.8 && goodShare(bear, "SYMBOL") > 0.2);
  // A bear market is a busier tape.
  assert.ok(bear.length > bull.length);
});

test("a hiking cycle is mostly hikes and hot inflation prints", () => {
  const hawkish = new Set(["macro.rate.hike", "macro.cpi.hot"]);
  const dovish = new Set(["macro.rate.cut", "macro.cpi.cool"]);
  const count = (items: readonly NewsItem[], ids: ReadonlySet<string>) =>
    items.filter((item) => ids.has(item.templateId)).length;
  const hiking = runNews(mood({ channelLean: { RATE: 0.7, FX: 0, OIL: 0, COMMODITY: 0, GLOBAL: 0 } }), 24 * 6, 11);
  const easing = runNews(mood({ channelLean: { RATE: -0.7, FX: 0, OIL: 0, COMMODITY: 0, GLOBAL: 0 } }), 24 * 6, 11);
  assert.ok(count(hiking, hawkish) > 2 * count(hiking, dovish), `hiking ${count(hiking, hawkish)}:${count(hiking, dovish)}`);
  assert.ok(count(easing, dovish) > 2 * count(easing, hawkish), `easing ${count(easing, dovish)}:${count(easing, hawkish)}`);
});

test("the cycle leans ordinary flow more gently than an admin scenario", () => {
  const cycleOnly = new MarketModel(SYMBOLS, { random: seededRandom(3), marketLean: () => 1 });
  const scenarioOnly = new MarketModel(SYMBOLS, { random: seededRandom(3), scenarioPressure: () => 1 });
  const neither = new MarketModel(SYMBOLS, { random: seededRandom(3) });
  const symbol = SYMBOLS[0].symbol;
  assert.equal(neither.flowBias(symbol), 0);
  assert.ok(cycleOnly.flowBias(symbol) > 0);
  assert.ok(cycleOnly.flowBias(symbol) < scenarioOnly.flowBias(symbol));
});
