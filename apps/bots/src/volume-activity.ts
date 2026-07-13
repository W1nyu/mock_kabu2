interface RandomSource {
  next(): number;
}

export interface VolumeActivityOptions {
  random?: RandomSource;
}

export interface VolumeActivitySample {
  /**
   * A direction-free activity multiplier. It only changes order frequency and
   * size; it is intentionally never used to choose BUY versus SELL.
   */
  intensity: number;
}

interface ActivityState {
  baseline: number;
  pulseOrdersLeft: number;
}

const MIN_INTENSITY = 0.3;
const MAX_INTENSITY = 2.6;

/**
 * Flow sizes use a money-like anchor instead of a fixed share count. A low
 * priced symbol therefore prints more shares for the same ordinary activity,
 * while an expensive symbol prints fewer.
 */
export const FLOW_REFERENCE_PRICE = 120_000;
/** A single aggressive bot may walk at most the nearest three levels. */
export const MAX_TAKER_LEVELS = 3;
/** Keeps a one-off sweep material without turning it into a book wipe. */
export const MAX_TAKER_NOTIONAL = 24_000_000;

export interface TakerQuantityOptions {
  /** Current executable price (best ask for BUY, best bid for SELL). */
  price: number;
  /** Executable quantities ordered from the best level outward. */
  levelQtys: readonly number[];
  minSharesAtReference: number;
  maxSharesAtReference: number;
  intensity: number;
  /** Chance that this order deliberately walks past the first level. */
  sweepChance: number;
  random?: () => number;
  maxLevels?: number;
  maxNotional?: number;
}

export interface TakerQuantityDecision {
  qty: number;
  /** True only when the quantity is intentionally larger than the best wall. */
  sweepsBest: boolean;
}

/** Convert a reference share count into a price-normalised share count. */
export function priceScaledShares(sharesAtReference: number, price: number): number {
  const safeShares = Number.isFinite(sharesAtReference) ? Math.max(1, sharesAtReference) : 1;
  const safePrice = Number.isFinite(price) && price > 0 ? price : FLOW_REFERENCE_PRICE;
  // A generous range supports a future penny listing without making one
  // noisy order unbounded, and prevents expensive shares becoming zero-share.
  const scale = clamp(FLOW_REFERENCE_PRICE / safePrice, 0.15, 32);
  return Math.max(1, Math.round(safeShares * scale));
}

/**
 * Prefer an inner book level only occasionally; most passive churn lands in
 * the middle or outer visible wall, not permanently at the best quote.
 */
export function chooseBookLevelIndex(levelCount: number, random: () => number = Math.random): number {
  const count = Math.max(0, Math.floor(levelCount));
  if (count <= 1) return 0;
  const roll = clamp(random(), 0, 0.999_999);
  if (roll < 0.16) return 0;
  return 1 + Math.floor(clamp(random(), 0, 0.999_999) * (count - 1));
}

/**
 * Produces two genuinely different execution shapes. Most orders are smaller
 * than the current best wall; a stochastic minority is larger and walks one
 * to three levels. Both shapes scale in shares inversely with price.
 */
export function chooseMarketTakerQuantity(options: TakerQuantityOptions): TakerQuantityDecision {
  const random = options.random ?? Math.random;
  const price = Number.isFinite(options.price) && options.price > 0 ? options.price : FLOW_REFERENCE_PRICE;
  const levelQtys = options.levelQtys
    .filter((qty) => Number.isSafeInteger(qty) && qty > 0)
    .slice(0, Math.max(1, Math.floor(options.maxLevels ?? MAX_TAKER_LEVELS)));
  const min = priceScaledShares(options.minSharesAtReference, price);
  const max = Math.max(min, priceScaledShares(options.maxSharesAtReference, price));
  const intensity = clamp(options.intensity, MIN_INTENSITY, MAX_INTENSITY);
  const base = Math.max(min, Math.round((min + random() * (max - min)) * intensity));
  const best = levelQtys[0];

  if (!best) return { qty: base, sweepsBest: false };

  const sweepChance = clamp(options.sweepChance, 0, 1);
  if (random() < sweepChance && levelQtys.length >= 2) {
    const reachableQty = levelQtys.reduce((sum, qty) => sum + qty, 0);
    const notionalCap = Math.max(1, Math.floor((options.maxNotional ?? MAX_TAKER_NOTIONAL) / price));
    const cap = Math.min(reachableQty, notionalCap);
    if (cap > best) {
      const shareOfReachable = 0.25 + random() * 0.65;
      return {
        qty: Math.min(cap, Math.max(best + 1, Math.round(best + (cap - best) * shareOfReachable))),
        sweepsBest: true,
      };
    }
  }

  // Normal trades remain below the best quote so quiet, sub-wall prints are
  // always present between the occasional controlled sweep.
  const insideCap = best <= 1 ? 1 : Math.max(1, Math.floor(best * (0.18 + random() * 0.52)));
  return { qty: Math.min(base, insideCap), sweepsBest: false };
}

/**
 * Gives each symbol a random, mean-reverting trading-activity level. Quiet
 * stretches and short busy pulses arise stochastically, rather than from a
 * scheduled cycle or a price-direction rule.
 */
export class VolumeActivity {
  private readonly states = new Map<string, ActivityState>();
  private readonly random: RandomSource;

  constructor(symbols: Iterable<string>, options: VolumeActivityOptions = {}) {
    this.random = options.random ?? { next: () => Math.random() };
    for (const symbol of symbols) {
      this.states.set(symbol, { baseline: 1, pulseOrdersLeft: 0 });
    }
  }

  sample(symbol: string): VolumeActivitySample {
    const state = this.states.get(symbol) ?? { baseline: 1, pulseOrdersLeft: 0 };
    this.states.set(symbol, state);

    // A small random walk around one preserves both thin and busy stretches
    // without coupling activity to the side or outcome of any execution.
    const shock = (this.random.next() - 0.5) * 0.65;
    state.baseline = clamp(1 + (state.baseline - 1) * 0.84 + shock, MIN_INTENSITY, 1.85);

    // Rare, short activity pulses create clustered prints. They affect only
    // subsequent order volume and cadence, never the buy/sell choice.
    if (state.pulseOrdersLeft === 0 && this.random.next() < 0.045) {
      state.pulseOrdersLeft = 2 + Math.floor(this.random.next() * 5);
    }

    let intensity = state.baseline;
    if (state.pulseOrdersLeft > 0) {
      state.pulseOrdersLeft--;
      intensity *= 1.35 + this.random.next() * 0.75;
    }

    return { intensity: clamp(intensity, MIN_INTENSITY, MAX_INTENSITY) };
  }

  /** Produces a bounded integer order size for an activity sample. */
  quantityFor(sample: VolumeActivitySample, min: number, max: number, hardCap: number): number {
    const base = min + this.random.next() * Math.max(0, max - min);
    return Math.min(hardCap, Math.max(min, Math.round(base * sample.intensity)));
  }

  /** Makes busy periods quicker and quiet periods slower without tight loops. */
  delayFor(sample: VolumeActivitySample, minMs: number, maxMs: number, floorMs: number): number {
    const base = minMs + this.random.next() * Math.max(0, maxMs - minMs);
    return clamp(Math.round(base / sample.intensity), floorMs, Math.round(maxMs * 2.4));
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
