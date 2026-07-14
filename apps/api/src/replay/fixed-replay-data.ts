import type { ReplayCandle, ReplayDataset } from "./replay.types";

/** Always visible before a user starts the future replay path. */
export const FIXED_REPLAY_PRE_ROLL_CANDLE_COUNT = 200;
/** The selectable future horizon is deliberately capped at three calendar years. */
export const FIXED_REPLAY_MAX_REPLAY_CANDLE_COUNT = 365 * 3;
/** Source horizon: 200 visible history bars plus the longest replay path. */
export const FIXED_REPLAY_CANDLE_COUNT =
  FIXED_REPLAY_PRE_ROLL_CANDLE_COUNT + FIXED_REPLAY_MAX_REPLAY_CANDLE_COUNT;
export const FIXED_REPLAY_DATA_FIXED_AT = "2025-12-31T00:00:00.000Z";

const DAY_MS = 24 * 60 * 60 * 1_000;
const LAST_CANDLE_TS = Date.UTC(2025, 11, 31);

type FixedReplayProfile = {
  basePrice: number;
  dailyDrift: number;
  dailyVolatility: number;
  averageVolume: number;
  seed: number;
};

/**
 * These are deterministic exercise profiles, not a live or licensed price
 * feed. Keeping only compact profile parameters in source gives every ticker
 * the same reproducible 1,295-candle timeline without an external request.
 */
const PROFILES: Readonly<Record<string, FixedReplayProfile>> = {
  "aapl-us": { basePrice: 18_500, dailyDrift: 0.00018, dailyVolatility: 0.019, averageVolume: 58_000_000, seed: 0x41a7 },
  "msft-us": { basePrice: 37_500, dailyDrift: 0.0002, dailyVolatility: 0.017, averageVolume: 24_000_000, seed: 0x5f71 },
  "nvda-us": { basePrice: 11_500, dailyDrift: 0.00032, dailyVolatility: 0.034, averageVolume: 310_000_000, seed: 0x9d43 },
  "amzn-us": { basePrice: 17_500, dailyDrift: 0.00016, dailyVolatility: 0.024, averageVolume: 42_000_000, seed: 0x8e23 },
  "googl-us": { basePrice: 16_000, dailyDrift: 0.00017, dailyVolatility: 0.021, averageVolume: 29_000_000, seed: 0x6c55 },
  "meta-us": { basePrice: 46_000, dailyDrift: 0.00025, dailyVolatility: 0.029, averageVolume: 18_000_000, seed: 0x7b91 },
  "tsla-us": { basePrice: 26_000, dailyDrift: 0.00008, dailyVolatility: 0.041, averageVolume: 95_000_000, seed: 0x2d79 },
  "amd-us": { basePrice: 14_000, dailyDrift: 0.00022, dailyVolatility: 0.035, averageVolume: 61_000_000, seed: 0x3fa1 },
  "nflx-us": { basePrice: 58_000, dailyDrift: 0.0002, dailyVolatility: 0.025, averageVolume: 5_800_000, seed: 0xa649 },
  "jpm-us": { basePrice: 19_000, dailyDrift: 0.00012, dailyVolatility: 0.016, averageVolume: 10_000_000, seed: 0x52cb },
  "samsung-electronics-kr": { basePrice: 68_000, dailyDrift: 0.00015, dailyVolatility: 0.021, averageVolume: 14_500_000, seed: 0x05930 },
  "sk-hynix-kr": { basePrice: 114_000, dailyDrift: 0.00023, dailyVolatility: 0.031, averageVolume: 3_700_000, seed: 0x00660 },
  "hyundai-motor-kr": { basePrice: 185_000, dailyDrift: 0.00013, dailyVolatility: 0.023, averageVolume: 740_000, seed: 0x05380 },
  "naver-kr": { basePrice: 188_000, dailyDrift: 0.00012, dailyVolatility: 0.027, averageVolume: 920_000, seed: 0x35420 },
  "posco-holdings-kr": { basePrice: 315_000, dailyDrift: 0.0001, dailyVolatility: 0.028, averageVolume: 430_000, seed: 0x05490 },
  "btc-usd": { basePrice: 4_200_000, dailyDrift: 0.00028, dailyVolatility: 0.046, averageVolume: 24_000, seed: 0xb7c0 },
};

const cache = new Map<string, readonly ReplayCandle[]>();

export function fixedReplayCandlesFor(dataset: ReplayDataset): readonly ReplayCandle[] {
  const existing = cache.get(dataset.id);
  if (existing) return existing;

  const profile = PROFILES[dataset.id];
  if (!profile) throw new Error(`Missing fixed replay profile for ${dataset.id}`);

  const random = seededRandom(profile.seed);
  const firstTimestamp = LAST_CANDLE_TS - (FIXED_REPLAY_CANDLE_COUNT - 1) * DAY_MS;
  const candles: ReplayCandle[] = [];
  let previousClose = profile.basePrice;

  for (let index = 0; index < FIXED_REPLAY_CANDLE_COUNT; index += 1) {
    const cycle = Math.sin((index + profile.seed % 47) / 31) * profile.dailyVolatility * 0.18;
    const gap = (random() - 0.5) * profile.dailyVolatility * 0.7;
    const open = positiveMinor(Math.round(previousClose * (1 + gap)));
    const movement = (random() + random() + random() - 1.5) * profile.dailyVolatility + profile.dailyDrift + cycle;
    const close = positiveMinor(Math.round(open * (1 + movement)));
    const intradayRange = Math.max(0.0025, Math.abs(movement) * 0.65 + random() * profile.dailyVolatility * 0.75);
    const high = Math.max(open, close, Math.round(Math.max(open, close) * (1 + intradayRange)));
    const low = Math.min(open, close, positiveMinor(Math.round(Math.min(open, close) * (1 - intradayRange))));
    const volumeMultiplier = 0.58 + random() * 0.84 + Math.min(0.65, Math.abs(movement) * 18);

    candles.push({
      ts: firstTimestamp + index * DAY_MS,
      open,
      high,
      low,
      close,
      volume: Math.max(1, Math.round(profile.averageVolume * volumeMultiplier)),
    });
    previousClose = close;
  }

  const frozen = Object.freeze(candles);
  cache.set(dataset.id, frozen);
  return frozen;
}

function positiveMinor(value: number): number {
  return Math.max(100, value);
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
