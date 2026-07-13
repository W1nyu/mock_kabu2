/**
 * Pure historical-price replay primitives.
 *
 * This module deliberately has no network, clock, database, or exchange
 * dependencies.  A UI can feed it normalized OHLCV candles from any provider
 * and keep its own request/cache policy separate from replay behaviour.
 */

/** The playback rates shown to a user. */
export const REPLAY_SPEEDS = [0.25, 0.5, 1, 2] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

export type ReplayMode = "historical" | "hybrid";
export type ReplayStatus = "playing" | "paused" | "finished";

/**
 * Provider-independent OHLCV input. `ts` is the source candle's start time in
 * Unix milliseconds.  Volume is optional because some free data sources do
 * not provide it for every instrument.
 */
export interface ReplayCandleInput {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/** A validated candle used by the replay engine and directly consumable by charts. */
export interface ReplayCandle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * A point on an OHLC-preserving intrabar path.  With only OHLC data the true
 * tick order is unavailable; the replay uses a deterministic path that visits
 * both extrema but never exposes a future extremum before that point.
 */
export interface ReplayQuote {
  barIndex: number;
  progress: number;
  ts: number;
  /** Price derived solely from the historical source candle. */
  referencePrice: number;
  /** Display/tradable price. Equals `referencePrice` in historical mode. */
  price: number;
  /** Inclusive allowed bounds for the displayed price. */
  lowerBound: number;
  upperBound: number;
  /** Difference between `price` and the source reference in basis points. */
  perturbationBps: number;
  /** Smooth, seeded virtual liquidity pressure in the inclusive range [-1, 1]. */
  syntheticPressure: number;
}

/** Configuration for the deterministic, virtual bot/noise layer. */
export interface HybridReplayConfig {
  /**
   * Maximum deviation from the source reference price in basis points.
   * For example, 250 means the displayed price is constrained to +/-2.5%.
   */
  bandBps: number;
  /** Price increment used when a valid tick exists inside the configured band. Defaults to 1. */
  tickSize?: number;
  /** Reproducible seed. The same seed, candle, and progress always yield the same quote. */
  seed?: number;
  /** Noise amplitude in basis points. Defaults to 70% of `bandBps`. */
  noiseBps?: number;
}

export interface HistoricalReplayOptions {
  /** Real milliseconds taken to play one source candle at 1x. Defaults to 5 seconds. */
  barDurationMs?: number;
  speed?: ReplaySpeed;
  /** Number of source candles to reveal immediately. Defaults to 0. */
  startIndex?: number;
}

export interface HybridReplayOptions extends HistoricalReplayOptions, HybridReplayConfig {}

export interface ReplaySnapshot {
  mode: ReplayMode;
  status: ReplayStatus;
  speed: ReplaySpeed;
  /** Number of fully revealed source candles. */
  completedBars: number;
  totalBars: number;
  /** Index of the currently forming source candle, or the final bar once finished. */
  barIndex: number;
  /** Current candle progress in the inclusive range [0, 1]. */
  progress: number;
  current: ReplayQuote;
  /** Completed candles plus one partially observed current candle while playing. */
  visibleCandles: ReplayCandle[];
}

const INTRABAR_KNOTS = [0, 0.28, 0.7, 1] as const;
const TAU = Math.PI * 2;

/** True only for the rates supported by the replay UI. */
export function isReplaySpeed(value: number): value is ReplaySpeed {
  return (REPLAY_SPEEDS as readonly number[]).includes(value);
}

/** Converts elapsed wall-clock milliseconds into replay-time milliseconds. */
export function scaleReplayElapsedMs(elapsedMs: number, speed: ReplaySpeed): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    throw new Error("Replay elapsed time must be a non-negative finite number");
  }
  if (!isReplaySpeed(speed)) throw new Error(`Unsupported replay speed: ${speed}`);
  return elapsedMs * speed;
}

/**
 * Validates and chronologically sorts a provider-neutral candle sequence.
 * Normalizing at the boundary keeps chart code from having to
 * defend against malformed or reverse-ordered remote rows.
 */
export function normalizeReplayCandles(candles: readonly ReplayCandleInput[]): ReplayCandle[] {
  if (candles.length === 0) throw new Error("At least one historical candle is required");

  const normalized = candles.map((candle, index) => normalizeCandle(candle, index));
  normalized.sort((a, b) => a.ts - b.ts);

  for (let index = 1; index < normalized.length; index++) {
    if (normalized[index - 1].ts === normalized[index].ts) {
      throw new Error(`Historical candles contain a duplicate timestamp: ${normalized[index].ts}`);
    }
  }

  return normalized;
}

/**
 * Returns the source-only quote for a candle at a fractional point in time.
 * The method is intentionally stateless, so React renders and timer batching
 * cannot change the resulting historical path.
 */
export function replayQuoteAt(candle: ReplayCandle, barIndex: number, progress: number): ReplayQuote {
  const normalizedProgress = normalizeProgress(progress);
  const referencePrice = sourcePriceAt(candle, normalizedProgress);
  return {
    barIndex,
    progress: normalizedProgress,
    ts: candle.ts,
    referencePrice,
    price: referencePrice,
    lowerBound: referencePrice,
    upperBound: referencePrice,
    perturbationBps: 0,
    syntheticPressure: 0,
  };
}

/**
 * Returns an observed (not future-leaking) source candle at `progress`.
 * At progress 0 the candle contains its opening price and zero volume; at 1 it
 * equals the original normalized source candle.
 */
export function replayCandleAt(
  candles: readonly ReplayCandle[],
  barIndex: number,
  progress: number,
): ReplayCandle {
  return replayCandleProgressAt(candleAtIndex(candles, barIndex), progress);
}

/** Same source-only observed-candle calculation for a single normalized bar. */
export function replayCandleProgressAt(candle: ReplayCandle, progress: number): ReplayCandle {
  return observedCandle(candle, 0, progress, (source, index, point) => replayQuoteAt(source, index, point));
}

/**
 * Adds a deterministic virtual liquidity pressure to the source price.  The
 * returned value is always constrained to the exact +/- `bandBps` interval
 * around the source reference price, including after tick rounding.
 */
export function hybridReplayQuoteAt(
  candle: ReplayCandle,
  barIndex: number,
  progress: number,
  config: HybridReplayConfig,
): ReplayQuote {
  const normalizedProgress = normalizeProgress(progress);
  const normalizedConfig = normalizeHybridConfig(config);
  const referencePrice = sourcePriceAt(candle, normalizedProgress);
  const bandRatio = normalizedConfig.bandBps / 10_000;
  const lowerBound = referencePrice * (1 - bandRatio);
  const upperBound = referencePrice * (1 + bandRatio);

  // The envelope is zero at each source-bar boundary.  It keeps adjacent bars
  // continuous and prevents synthetic pressure from accumulating into a drift
  // away from the historical path.
  const envelope = Math.sin(Math.PI * normalizedProgress);
  const syntheticPressure = clamp(
    pressureAt(normalizedConfig.seed, barIndex, normalizedProgress) * envelope,
    -1,
    1,
  );
  const rawPrice = referencePrice * (1 + syntheticPressure * (normalizedConfig.noiseBps / 10_000));
  // Preserve source-bar boundaries exactly, including fractional split-adjusted
  // prices returned by providers that do not align with a display tick size.
  const price =
    normalizedProgress === 0 || normalizedProgress === 1 || normalizedConfig.noiseBps === 0
      ? referencePrice
      : roundWithinBand(rawPrice, lowerBound, upperBound, normalizedConfig.tickSize);

  return {
    barIndex,
    progress: normalizedProgress,
    ts: candle.ts,
    referencePrice,
    price,
    lowerBound,
    upperBound,
    perturbationBps: ((price - referencePrice) / referencePrice) * 10_000,
    syntheticPressure,
  };
}

/** Same observed-candle helper as `replayCandleAt`, with the hybrid price layer applied. */
export function hybridReplayCandleAt(
  candles: readonly ReplayCandle[],
  barIndex: number,
  progress: number,
  config: HybridReplayConfig,
): ReplayCandle {
  return hybridReplayCandleProgressAt(candleAtIndex(candles, barIndex), barIndex, progress, config);
}

/** Same hybrid observed-candle calculation for a single normalized bar. */
export function hybridReplayCandleProgressAt(
  candle: ReplayCandle,
  barIndex: number,
  progress: number,
  config: HybridReplayConfig,
): ReplayCandle {
  return observedCandle(candle, barIndex, progress, (source, index, point) =>
    hybridReplayQuoteAt(source, index, point, config),
  );
}

/**
 * A clock-free stateful controller intended for a React timer.  Call
 * `advance(realElapsedMs)` from an interval or animation frame; no ambient
 * `Date.now()` is read here, which keeps replay tests deterministic.
 */
export class HistoricalReplayEngine {
  readonly mode: ReplayMode = "historical";
  protected readonly candles: ReplayCandle[];
  private readonly barDurationMs: number;
  private elapsedMs: number;
  private speed: ReplaySpeed;
  private status: ReplayStatus = "paused";

  constructor(candles: readonly ReplayCandleInput[], options: HistoricalReplayOptions = {}) {
    this.candles = normalizeReplayCandles(candles);
    this.barDurationMs = positiveFinite(options.barDurationMs ?? 5_000, "barDurationMs");
    this.speed = options.speed ?? 1;
    if (!isReplaySpeed(this.speed)) throw new Error(`Unsupported replay speed: ${this.speed}`);

    const startIndex = options.startIndex ?? 0;
    if (!Number.isInteger(startIndex) || startIndex < 0 || startIndex > this.candles.length) {
      throw new Error(`Replay startIndex must be between 0 and ${this.candles.length}`);
    }
    this.elapsedMs = startIndex * this.barDurationMs;
    if (this.elapsedMs >= this.totalDurationMs()) this.status = "finished";
  }

  play(): ReplaySnapshot {
    if (this.elapsedMs < this.totalDurationMs()) this.status = "playing";
    else this.status = "finished";
    return this.snapshot();
  }

  pause(): ReplaySnapshot {
    if (this.status !== "finished") this.status = "paused";
    return this.snapshot();
  }

  reset(startIndex = 0): ReplaySnapshot {
    this.seek(startIndex, 0);
    this.status = "paused";
    return this.snapshot();
  }

  setSpeed(speed: ReplaySpeed): ReplaySnapshot {
    if (!isReplaySpeed(speed)) throw new Error(`Unsupported replay speed: ${speed}`);
    this.speed = speed;
    return this.snapshot();
  }

  /** Seek to a source bar; `index === totalBars` is the completed end state. */
  seek(index: number, progress = 0): ReplaySnapshot {
    if (!Number.isInteger(index) || index < 0 || index > this.candles.length) {
      throw new Error(`Replay index must be between 0 and ${this.candles.length}`);
    }
    const normalizedProgress = normalizeProgress(progress);
    if (index === this.candles.length && normalizedProgress !== 0) {
      throw new Error("The completed replay position cannot have partial progress");
    }
    this.elapsedMs = Math.min(
      this.totalDurationMs(),
      (index + (index === this.candles.length ? 0 : normalizedProgress)) * this.barDurationMs,
    );
    this.status = this.elapsedMs >= this.totalDurationMs() ? "finished" : "paused";
    return this.snapshot();
  }

  advance(realElapsedMs: number): ReplaySnapshot {
    if (this.status !== "playing") return this.snapshot();
    this.elapsedMs = Math.min(
      this.totalDurationMs(),
      this.elapsedMs + scaleReplayElapsedMs(realElapsedMs, this.speed),
    );
    if (this.elapsedMs >= this.totalDurationMs()) this.status = "finished";
    return this.snapshot();
  }

  snapshot(): ReplaySnapshot {
    const position = this.position();
    return {
      mode: this.mode,
      status: this.status,
      speed: this.speed,
      completedBars: position.completedBars,
      totalBars: this.candles.length,
      barIndex: position.barIndex,
      progress: position.progress,
      current: this.quoteAt(position.barIndex, position.progress),
      visibleCandles: this.visibleCandles(position.completedBars, position.barIndex, position.progress),
    };
  }

  protected quoteAt(barIndex: number, progress: number): ReplayQuote {
    return replayQuoteAt(this.candles[barIndex], barIndex, progress);
  }

  protected candleAt(barIndex: number, progress: number): ReplayCandle {
    return replayCandleAt(this.candles, barIndex, progress);
  }

  private visibleCandles(completedBars: number, barIndex: number, progress: number): ReplayCandle[] {
    const result: ReplayCandle[] = [];
    for (let index = 0; index < completedBars; index++) result.push(this.candleAt(index, 1));
    if (completedBars < this.candles.length) result.push(this.candleAt(barIndex, progress));
    return result;
  }

  private position(): { completedBars: number; barIndex: number; progress: number } {
    const totalBars = this.candles.length;
    if (this.elapsedMs >= this.totalDurationMs()) {
      return { completedBars: totalBars, barIndex: totalBars - 1, progress: 1 };
    }
    const barIndex = Math.floor(this.elapsedMs / this.barDurationMs);
    const progress = (this.elapsedMs - barIndex * this.barDurationMs) / this.barDurationMs;
    return { completedBars: barIndex, barIndex, progress };
  }

  private totalDurationMs(): number {
    return this.candles.length * this.barDurationMs;
  }
}

/**
 * Historical replay with a deterministic, bounded virtual bot/noise layer.
 * It has no dependency on the live exchange's bots, matching engine, orders,
 * accounts, or settlement consumers.
 */
export class HybridReplayEngine extends HistoricalReplayEngine {
  override readonly mode: ReplayMode = "hybrid";
  private readonly hybridConfig: HybridReplayConfig;

  constructor(candles: readonly ReplayCandleInput[], options: HybridReplayOptions) {
    super(candles, options);
    this.hybridConfig = normalizeHybridConfig(options);
  }

  protected override quoteAt(barIndex: number, progress: number): ReplayQuote {
    return hybridReplayQuoteAt(this.candles[barIndex], barIndex, progress, this.hybridConfig);
  }

  protected override candleAt(barIndex: number, progress: number): ReplayCandle {
    return hybridReplayCandleAt(this.candles, barIndex, progress, this.hybridConfig);
  }
}

function normalizeCandle(candle: ReplayCandleInput, index: number): ReplayCandle {
  const label = `Historical candle at index ${index}`;
  if (!Number.isSafeInteger(candle.ts) || candle.ts <= 0) throw new Error(`${label} has an invalid timestamp`);
  const open = positiveFinite(candle.open, `${label} open`);
  const high = positiveFinite(candle.high, `${label} high`);
  const low = positiveFinite(candle.low, `${label} low`);
  const close = positiveFinite(candle.close, `${label} close`);
  const volume = candle.volume == null ? 0 : nonNegativeFinite(candle.volume, `${label} volume`);
  if (high < Math.max(open, close) || low > Math.min(open, close) || low > high) {
    throw new Error(`${label} has inconsistent OHLC values`);
  }
  return { ts: candle.ts, open, high, low, close, volume };
}

function sourcePriceAt(candle: ReplayCandle, progress: number): number {
  const points = candle.close >= candle.open
    ? [candle.open, candle.low, candle.high, candle.close]
    : [candle.open, candle.high, candle.low, candle.close];

  for (let index = 1; index < INTRABAR_KNOTS.length; index++) {
    const end = INTRABAR_KNOTS[index];
    if (progress <= end) {
      const start = INTRABAR_KNOTS[index - 1];
      const fraction = (progress - start) / (end - start);
      return points[index - 1] + (points[index] - points[index - 1]) * fraction;
    }
  }
  return candle.close;
}

function observedCandle(
  candle: ReplayCandle,
  barIndex: number,
  progress: number,
  quoteAt: (candle: ReplayCandle, barIndex: number, progress: number) => ReplayQuote,
): ReplayCandle {
  const normalizedProgress = normalizeProgress(progress);
  const sampledProgresses = observedProgresses(normalizedProgress);
  const prices = sampledProgresses.map((point) => quoteAt(candle, barIndex, point).price);
  return {
    ts: candle.ts,
    open: prices[0],
    high: Math.max(...prices),
    low: Math.min(...prices),
    close: prices[prices.length - 1],
    volume: candle.volume * normalizedProgress,
  };
}

function candleAtIndex(candles: readonly ReplayCandle[], barIndex: number): ReplayCandle {
  if (!Number.isInteger(barIndex) || barIndex < 0 || barIndex >= candles.length) {
    throw new Error(`Replay barIndex must be between 0 and ${Math.max(candles.length - 1, 0)}`);
  }
  return candles[barIndex];
}

function observedProgresses(progress: number): number[] {
  const points = new Set<number>([0, progress]);
  for (const knot of INTRABAR_KNOTS) if (knot <= progress) points.add(knot);
  // Capture deterministic hybrid waves between OHLC knots as well.
  const samples = Math.ceil(progress * 24);
  for (let index = 1; index < samples; index++) points.add((progress * index) / samples);
  return [...points].sort((a, b) => a - b);
}

function normalizeHybridConfig(config: HybridReplayConfig): Required<HybridReplayConfig> {
  const bandBps = nonNegativeFinite(config.bandBps, "Hybrid replay bandBps");
  if (bandBps > 10_000) throw new Error("Hybrid replay bandBps cannot exceed 10000");
  const tickSize = positiveFinite(config.tickSize ?? 1, "Hybrid replay tickSize");
  const noiseBps = nonNegativeFinite(config.noiseBps ?? bandBps * 0.7, "Hybrid replay noiseBps");
  if (noiseBps > bandBps) throw new Error("Hybrid replay noiseBps cannot exceed bandBps");
  const seed = Number.isFinite(config.seed) ? Math.trunc(config.seed!) : 0x4d4b5250;
  return { bandBps, tickSize, noiseBps, seed };
}

function pressureAt(seed: number, barIndex: number, progress: number): number {
  const phaseA = unit(seed, barIndex, 11) * TAU;
  const phaseB = unit(seed, barIndex, 29) * TAU;
  const frequencyA = 1.1 + unit(seed, barIndex, 47) * 1.8;
  const frequencyB = 2.6 + unit(seed, barIndex, 71) * 3.2;
  const bias = (unit(seed, barIndex, 97) * 2 - 1) * 0.22;
  const pressure =
    0.58 * Math.sin(TAU * frequencyA * progress + phaseA) +
    0.3 * Math.sin(TAU * frequencyB * progress + phaseB) +
    bias;
  return clamp(pressure, -1, 1);
}

function unit(seed: number, barIndex: number, salt: number): number {
  let value = (Math.trunc(seed) ^ Math.imul(barIndex + 1, 0x9e3779b1) ^ Math.imul(salt, 0x85ebca6b)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d) >>> 0;
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b) >>> 0;
  value ^= value >>> 16;
  return value / 0x1_0000_0000;
}

function roundWithinBand(value: number, lowerBound: number, upperBound: number, tickSize: number): number {
  const rounded = Math.round(value / tickSize) * tickSize;
  if (rounded >= lowerBound && rounded <= upperBound) return rounded;

  const lowestPermittedTick = Math.ceil(lowerBound / tickSize) * tickSize;
  const highestPermittedTick = Math.floor(upperBound / tickSize) * tickSize;
  if (lowestPermittedTick <= highestPermittedTick) {
    return clamp(rounded, lowestPermittedTick, highestPermittedTick);
  }

  // A very narrow band can contain no whole tick. Preserve the strict price
  // bound rather than emitting an invalid price; callers should pick a finer
  // tick size if their instrument requires every quote to be tick-aligned.
  return clamp(value, lowerBound, upperBound);
}

function normalizeProgress(progress: number): number {
  if (!Number.isFinite(progress)) throw new Error("Replay progress must be finite");
  return clamp(progress, 0, 1);
}

function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive finite number`);
  return value;
}

function nonNegativeFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative finite number`);
  return value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
