import assert from "node:assert/strict";
import test from "node:test";
import {
  HistoricalReplayEngine,
  HybridReplayEngine,
  hybridReplayQuoteAt,
  normalizeReplayCandles,
  replayCandleAt,
  scaleReplayElapsedMs,
} from "../dist/index.js";

const CANDLES = [
  { ts: 1_700_000_000_000, open: 100, high: 118, low: 92, close: 110, volume: 1_200 },
  { ts: 1_700_000_060_000, open: 110, high: 114, low: 96, close: 101, volume: 900 },
];

test("normalization sorts provider rows and rejects invalid OHLC", () => {
  const candles = normalizeReplayCandles([...CANDLES].reverse());
  assert.deepEqual(candles.map((candle) => candle.ts), CANDLES.map((candle) => candle.ts));
  assert.throws(
    () => normalizeReplayCandles([{ ts: 1, open: 100, high: 95, low: 90, close: 100 }]),
    /inconsistent OHLC/,
  );
});

test("a partial source candle never reveals a future high or low", () => {
  const [candle] = normalizeReplayCandles(CANDLES);
  const early = replayCandleAt([candle], 0, 0.1);
  assert.equal(early.open, 100);
  assert.equal(early.high, 100);
  assert.ok(early.low < 100);
  assert.ok(early.high < candle.high);
  assert.equal(replayCandleAt([candle], 0, 1).high, candle.high);
  assert.equal(replayCandleAt([candle], 0, 1).low, candle.low);
});

test("hybrid quotes are deterministic and remain inside the exact source-price band", () => {
  const [candle] = normalizeReplayCandles(CANDLES);
  const config = { bandBps: 250, noiseBps: 180, tickSize: 1, seed: 73 };
  const first = hybridReplayQuoteAt(candle, 0, 0.42, config);
  const repeated = hybridReplayQuoteAt(candle, 0, 0.42, config);
  assert.deepEqual(repeated, first);
  assert.ok(first.price >= first.lowerBound && first.price <= first.upperBound);
  assert.ok(Math.abs(first.perturbationBps) <= config.bandBps + Number.EPSILON);

  // Synthetic pressure is zero on source-candle boundaries, so the replay
  // connects cleanly to the next source bar without accumulated drift.
  const start = hybridReplayQuoteAt(candle, 0, 0, config);
  const end = hybridReplayQuoteAt(candle, 0, 1, config);
  assert.equal(start.price, candle.open);
  assert.equal(end.price, candle.close);
});

test("hybrid bounds remain strict across fractional source prices and coarse ticks", () => {
  const [candle] = normalizeReplayCandles([
    { ts: 1_700_000_120_000, open: 100.3, high: 120.7, low: 90.1, close: 110.6, volume: 1 },
  ]);
  for (const tickSize of [0.01, 0.1, 1, 5, 50]) {
    for (const bandBps of [0, 1, 5, 30, 500]) {
      for (let index = 0; index <= 100; index++) {
        const quote = hybridReplayQuoteAt(candle, 2, index / 100, { bandBps, tickSize, seed: 3 });
        assert.ok(quote.price >= quote.lowerBound - 1e-9);
        assert.ok(quote.price <= quote.upperBound + 1e-9);
      }
    }
  }
});

test("speed scaling and stateful playback reveal candles at 0.25x, 0.5x, 1x, and 2x", () => {
  assert.equal(scaleReplayElapsedMs(1_000, 0.25), 250);
  assert.equal(scaleReplayElapsedMs(1_000, 0.5), 500);
  assert.equal(scaleReplayElapsedMs(1_000, 1), 1_000);
  assert.equal(scaleReplayElapsedMs(1_000, 2), 2_000);

  const replay = new HistoricalReplayEngine(CANDLES, { barDurationMs: 1_000, speed: 2 });
  replay.play();
  const half = replay.advance(250);
  assert.equal(half.completedBars, 0);
  assert.equal(half.progress, 0.5);
  assert.equal(half.visibleCandles.length, 1);

  const chunked = new HistoricalReplayEngine(CANDLES, { barDurationMs: 1_000, speed: 1 });
  const single = new HistoricalReplayEngine(CANDLES, { barDurationMs: 1_000, speed: 1 });
  chunked.play();
  single.play();
  chunked.advance(200);
  const chunkedSnapshot = chunked.advance(300);
  const singleSnapshot = single.advance(500);
  assert.deepEqual(chunkedSnapshot, singleSnapshot);

  const finished = replay.advance(1_000);
  assert.equal(finished.status, "finished");
  assert.equal(finished.completedBars, CANDLES.length);
  assert.equal(finished.visibleCandles.length, CANDLES.length);

  assert.equal(
    new HistoricalReplayEngine(CANDLES, { startIndex: CANDLES.length }).snapshot().status,
    "finished",
  );
});

test("hybrid engine is isolated from its source array and returns hybrid snapshots", () => {
  const source = [...CANDLES];
  const replay = new HybridReplayEngine(source, {
    barDurationMs: 1_000,
    bandBps: 300,
    tickSize: 1,
    seed: 9,
  });
  source[0].close = 1;
  replay.play();
  const snapshot = replay.advance(400);
  assert.equal(snapshot.mode, "hybrid");
  assert.ok(snapshot.current.price >= snapshot.current.lowerBound);
  assert.ok(snapshot.current.price <= snapshot.current.upperBound);
  assert.notEqual(snapshot.visibleCandles[0].close, 1);
});
