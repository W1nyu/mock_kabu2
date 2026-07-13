import type { SymbolDef } from "@mock-kabu/shared";

type MarketRegime = "CALM" | "UPTREND" | "DOWNTREND" | "VOLATILE";

interface RandomSource {
  next(): number;
}

export interface MarketModelOptions {
  /**
   * Restore the reference from a durable last trade or persisted last price,
   * rather than treating a restarted local service as a new listing.
   */
  initialPrices?: ReadonlyMap<string, number>;
  random?: RandomSource;
}

interface PriceState {
  price: number;
  anchor: number;
  previousReturn: number;
  variance: number;
}

interface SymbolProfile {
  beta: number;
  idiosyncraticVolatility: number;
  meanReversion: number;
}

const REGIME: Record<
  MarketRegime,
  { drift: number; marketVolatility: number; minTicks: number; maxTicks: number }
> = {
  CALM: { drift: 0, marketVolatility: 0.00035, minTicks: 50, maxTicks: 160 },
  UPTREND: { drift: 0.00012, marketVolatility: 0.00055, minTicks: 45, maxTicks: 130 },
  DOWNTREND: { drift: -0.00012, marketVolatility: 0.0006, minTicks: 45, maxTicks: 130 },
  VOLATILE: { drift: 0, marketVolatility: 0.00135, minTicks: 25, maxTicks: 80 },
};

const DEFAULT_PROFILE: SymbolProfile = {
  beta: 1,
  idiosyncraticVolatility: 0.00055,
  meanReversion: 0.012,
};

/** Checks whether an API/DB price can safely initialise a reference model. */
export function isUsableReferencePrice(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Prefer the most recent matched price, then the durable last price. Fall
 * back to the listing price only when neither exists.
 */
export function referencePriceFromHistory(
  initialPrice: number,
  persistedLastPrice: unknown,
  latestTradePrice: unknown,
): number {
  if (isUsableReferencePrice(latestTradePrice)) return latestTradePrice;
  if (isUsableReferencePrice(persistedLastPrice)) return persistedLastPrice;
  return initialPrice;
}

/**
 * A stochastic reference-price generator for market-maker decisions. It has
 * no dependency on a buyer/seller-pressure observer: tick() updates the quote
 * reference directly, while the displayed price still changes only on matched
 * orders.
 */
export class MarketModel {
  private readonly states = new Map<string, PriceState>();
  private readonly profiles = new Map<string, SymbolProfile>();
  private readonly random: RandomSource;
  private regime: MarketRegime = "CALM";
  private regimeTicksLeft = 0;
  private marketReturn = 0;
  private marketVariance = REGIME.CALM.marketVolatility ** 2;

  constructor(symbols: SymbolDef[], options: MarketModelOptions = {}) {
    this.random = options.random ?? { next: () => Math.random() };
    for (const [index, symbol] of symbols.entries()) {
      const restoredPrice = options.initialPrices?.get(symbol.symbol);
      const price = isUsableReferencePrice(restoredPrice) ? restoredPrice : symbol.initialPrice;
      this.states.set(symbol.symbol, {
        price,
        anchor: price,
        previousReturn: 0,
        variance: DEFAULT_PROFILE.idiosyncraticVolatility ** 2,
      });

      const variation = ((index * 37) % 11) / 100;
      this.profiles.set(symbol.symbol, {
        beta: 0.88 + variation * 2,
        idiosyncraticVolatility: 0.00042 + variation * 0.02,
        meanReversion: 0.009 + variation * 0.12,
      });
    }
    this.chooseNextRegime();
  }

  /** Advances all reference prices once. */
  tick() {
    if (--this.regimeTicksLeft <= 0) this.chooseNextRegime();

    const regime = REGIME[this.regime];
    const marketShock = gaussian(this.random);
    this.marketVariance = ewmaVariance(
      this.marketVariance,
      marketShock * regime.marketVolatility,
      regime.marketVolatility ** 2,
      0.08,
    );
    this.marketReturn = clamp(
      regime.drift + 0.18 * this.marketReturn + Math.sqrt(this.marketVariance) * marketShock,
      -0.007,
      0.007,
    );

    for (const [symbol, state] of this.states) {
      const profile = this.profiles.get(symbol) ?? DEFAULT_PROFILE;
      const idiosyncraticShock = gaussian(this.random) * profile.idiosyncraticVolatility;
      state.variance = ewmaVariance(
        state.variance,
        idiosyncraticShock,
        profile.idiosyncraticVolatility ** 2,
        0.1,
      );

      const displacement = Math.log(state.price / state.anchor);
      const jump =
        this.random.next() < (this.regime === "VOLATILE" ? 0.012 : 0.0025)
          ? gaussian(this.random) * (this.regime === "VOLATILE" ? 0.004 : 0.0018)
          : 0;
      const nextReturn = clamp(
        profile.beta * this.marketReturn +
          0.13 * state.previousReturn -
          profile.meanReversion * displacement +
          Math.sqrt(state.variance) * gaussian(this.random) +
          jump,
        -0.012,
        0.012,
      );

      state.previousReturn = nextReturn;
      state.price = this.withinDailyBand(Math.exp(nextReturn) * state.price, state.anchor);
      state.anchor = state.anchor * 0.996 + state.price * 0.004;
    }
  }

  get(symbol: string): number {
    const state = this.states.get(symbol);
    if (!state) throw new Error("Unknown symbol: " + symbol);
    return state.price;
  }

  private chooseNextRegime() {
    const roll = this.random.next();
    if (this.regime === "VOLATILE") {
      this.regime = roll < 0.55 ? "CALM" : roll < 0.78 ? "UPTREND" : "DOWNTREND";
    } else if (roll < 0.58) {
      this.regime = "CALM";
    } else if (roll < 0.77) {
      this.regime = "UPTREND";
    } else if (roll < 0.96) {
      this.regime = "DOWNTREND";
    } else {
      this.regime = "VOLATILE";
    }

    const config = REGIME[this.regime];
    this.regimeTicksLeft = randomInt(this.random, config.minTicks, config.maxTicks);
  }

  private withinDailyBand(price: number, anchor: number): number {
    return clamp(price, anchor * 0.72, anchor * 1.28);
  }
}

function gaussian(random: RandomSource): number {
  const u = Math.max(random.next(), Number.MIN_VALUE);
  const v = random.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function ewmaVariance(current: number, shock: number, baseline: number, weight: number): number {
  return (1 - weight) * current + weight * (shock * shock + baseline);
}

function randomInt(random: RandomSource, min: number, max: number): number {
  return Math.floor(random.next() * (max - min + 1)) + min;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
