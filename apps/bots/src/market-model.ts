import type { OrderSide, SymbolDef } from "@mock-kabu/shared";

type MarketRegime = "CALM" | "UPTREND" | "DOWNTREND" | "VOLATILE";

export interface RandomSource {
  next(): number;
}

export interface MarketModelOptions {
  /**
   * Restore the reference from a durable last trade or persisted last price,
   * rather than treating a restarted local service as a new listing.
   */
  initialPrices?: ReadonlyMap<string, number>;
  random?: RandomSource;
  /** Test-only tuning for deterministic event-generation coverage. */
  eventSpawnChance?: number;
}

export type MarketEventSentiment = "POSITIVE" | "NEGATIVE";

interface HiddenMarketEvent {
  /** Signed temporary log-return that still has to reach the market. */
  initialImpulse: number;
  remainingImpulse: number;
  /** 0..1 signal strength: stronger events bias more flow and trade volume. */
  strength: number;
  /** Per-tick retention, sampled higher for stronger events. */
  persistence: number;
  /** A rare burst, sampled when the event starts and retained until it ends. */
  volumeMultiplier: number;
}

interface PriceState {
  price: number;
  anchor: number;
  previousReturn: number;
  variance: number;
  events: HiddenMarketEvent[];
  sideways: SidewaysTracker;
  marketHistorySeeded: boolean;
  lastMarketObservationId?: string;
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

// These events remain entirely inside the bot process. They influence only
// normal bot orders and the reference price used by the market maker; no event
// payload is sent to the API, matching stream, socket, or dashboard.
const DEFAULT_EVENT_SPAWN_CHANCE = 0.004;
const EVENT_COOLDOWN_MIN_TICKS = 80;
const EVENT_COOLDOWN_MAX_TICKS = 160;
const MIN_EVENT_STRENGTH = 0.2;
const MAX_EVENT_STRENGTH = 1;
const MIN_EVENT_LOG_IMPACT = 0.006;
const MAX_EVENT_LOG_IMPACT = 0.04;
const PERMANENT_EQUILIBRIUM_SHARE = 0.4;
const MIN_REMAINING_EVENT_IMPULSE = 0.00008;
const MAX_EVENT_FLOW_INTENSITY = 4;
const MAX_SIDE_FLIP_CHANCE = 0.78;
/** A slight positive skew keeps good-news events marginally more common than bad-news events. */
export const POSITIVE_EVENT_PROBABILITY = 0.52;
/** A durable print this far from the synthetic reference establishes a new market level. */
const HARD_MARKET_REANCHOR_LOG_RETURN = 0.012;
const SOFT_MARKET_PRICE_BLEND = 0.28;
const SOFT_MARKET_ANCHOR_BLEND = 0.14;
const EVENT_MARKET_PRICE_BLEND = 0.12;
const EVENT_MARKET_ANCHOR_BLEND = 0.035;
const SIDEWAYS_HISTORY_SIZE = 120;
const SIDEWAYS_SHORT_WINDOW = 80;
const MIN_SIDEWAYS_OBSERVATIONS = 64;
const SIDEWAYS_REBASE_TICKS = 40;
const SIDEWAYS_BOOTSTRAP_CONFIRMATION_SCORE = 0.55;
const MIN_SIDEWAYS_MOVE = 0.0025;
const MAX_SIDEWAYS_BOX_WIDTH = 0.08;
const MIN_SIDEWAYS_BALANCE = 0.6;
// A strong low-frequency drift can turn an alternating path into a channel.
// We combine its span with smoothed directional coherence so a noisy, mean-
// reverting box is not rejected merely because its first/last samples differ.
const DIRECTIONAL_TREND_MIN_SHARE = 0.08;
const MAX_DIRECTIONAL_TREND_COHERENCE = 0.4;
const MIN_SIDEWAYS_ALTERNATIONS = 4;
const MIN_SIDEWAYS_CENTER_CROSSINGS = 4;

export interface SidewaysAssessment {
  score: number;
  boxWidth: number;
  upwardMove: number;
  downwardMove: number;
  alternations: number;
  centerCrossings: number;
  meanReversion: number;
  trendCoherence: number;
}

export interface HiddenEventProfile {
  strength: number;
  persistence: number;
  volumeBurstChance: number;
  volumeMultiplier: number;
}

/**
 * Keeps a fixed range baseline. It is chosen once from durable startup history
 * (only if that history already forms a convincing box), then changed solely
 * when an event has settled and a new durable price is observed after a quiet
 * period.
 */
export class SidewaysTracker {
  private baseline: number;
  private readonly prices: number[] = [];
  private rebasePending = false;
  private quietTicks = 0;

  constructor(baseline: number) {
    this.baseline = baseline;
  }

  markEventStarted() {
    this.prices.length = 0;
    this.rebasePending = true;
    this.quietTicks = 0;
  }

  /** Advance event-settlement time without treating a synthetic reference as a chart price. */
  advance(eventActive: boolean) {
    if (eventActive) {
      this.markEventStarted();
      return;
    }
    if (this.rebasePending) this.quietTicks++;
  }

  /**
   * Seed the initial fixed baseline from chart history. This is intentionally
   * unavailable after an event starts, so pre-event prices cannot leak into
   * the next equilibrium's range assessment.
   */
  seed(prices: Iterable<number>): number {
    if (this.rebasePending) return 0;
    const observations = [...prices]
      .filter((price) => Number.isFinite(price) && price > 0)
      .slice(-SIDEWAYS_HISTORY_SIZE);
    if (observations.length === 0) return 0;

    this.prices.length = 0;
    this.prices.push(...observations);
    let best: { score: number; baseline: number } | null = null;
    for (const windowSize of [SIDEWAYS_HISTORY_SIZE, SIDEWAYS_SHORT_WINDOW]) {
      if (this.prices.length < windowSize) continue;
      const window = this.prices.slice(-windowSize);
      const candidateBaseline = robustRangeCenter(window);
      const assessment = assessSidewaysMarket(window, candidateBaseline);
      if (!best || assessment.score > best.score) {
        best = { score: assessment.score, baseline: candidateBaseline };
      }
    }
    if (best && best.score >= SIDEWAYS_BOOTSTRAP_CONFIRMATION_SCORE) {
      this.baseline = best.baseline;
    }
    return observations.length;
  }

  observe(price: number, eventActive: boolean) {
    this.advance(eventActive);
    if (eventActive || !Number.isFinite(price) || price <= 0) return;
    if (this.rebasePending) {
      if (this.quietTicks < SIDEWAYS_REBASE_TICKS) return;
      this.baseline = price;
      this.prices.length = 0;
      this.rebasePending = false;
      this.quietTicks = 0;
    }
    this.prices.push(price);
    if (this.prices.length > SIDEWAYS_HISTORY_SIZE) this.prices.shift();
  }

  assessment(): SidewaysAssessment {
    const fullHistory = assessSidewaysMarket(this.prices, this.baseline);
    if (this.prices.length < SIDEWAYS_SHORT_WINDOW) return fullHistory;
    const recentBox = assessSidewaysMarket(this.prices.slice(-SIDEWAYS_SHORT_WINDOW), this.baseline);
    return recentBox.score > fullHistory.score ? recentBox : fullHistory;
  }
}

/**
 * Detect a genuine box range rather than merely a low price. A valid range
 * visits similarly sized upper/lower excursions around its fixed baseline,
 * has little net trend, and repeatedly alternates between the two sides.
 */
export function assessSidewaysMarket(prices: readonly number[], baseline: number): SidewaysAssessment {
  const empty = (): SidewaysAssessment => ({
    score: 0,
    boxWidth: 0,
    upwardMove: 0,
    downwardMove: 0,
    alternations: 0,
    centerCrossings: 0,
    meanReversion: 0,
    trendCoherence: 0,
  });
  if (!Number.isFinite(baseline) || baseline <= 0) return empty();
  const observations = prices.filter((price) => Number.isFinite(price) && price > 0);
  if (observations.length < MIN_SIDEWAYS_OBSERVATIONS) return empty();

  const deviations = observations.map((price) => Math.log(price / baseline));
  const sorted = [...deviations].sort((left, right) => left - right);
  const q10 = quantile(sorted, 0.1);
  const q90 = quantile(sorted, 0.9);
  const upwardMove = Math.max(0, q90);
  const downwardMove = Math.max(0, -q10);
  const boxWidth = q90 - q10;
  if (
    upwardMove < MIN_SIDEWAYS_MOVE ||
    downwardMove < MIN_SIDEWAYS_MOVE ||
    boxWidth > MAX_SIDEWAYS_BOX_WIDTH
  ) {
    return { ...empty(), boxWidth, upwardMove, downwardMove };
  }

  const balance = Math.min(upwardMove, downwardMove) / Math.max(upwardMove, downwardMove);
  const centerOffset = Math.abs((q90 + q10) / 2);
  const trendSpan = linearTrendSpan(deviations);
  const trendCoherence = smoothedTrendCoherence(deviations);
  const touchThreshold = Math.min(upwardMove, downwardMove) * 0.6;
  const alternations = countRangeAlternations(deviations, touchThreshold);
  const centerCrossings = countCenterCrossings(deviations);
  const meanReversion = meanReversionStrength(deviations);
  if (
    balance < MIN_SIDEWAYS_BALANCE ||
    centerOffset > boxWidth * 0.2 ||
    (trendSpan > boxWidth * DIRECTIONAL_TREND_MIN_SHARE &&
      trendCoherence > MAX_DIRECTIONAL_TREND_COHERENCE) ||
    alternations < MIN_SIDEWAYS_ALTERNATIONS ||
    centerCrossings < MIN_SIDEWAYS_CENTER_CROSSINGS
  ) {
    return {
      ...empty(),
      boxWidth,
      upwardMove,
      downwardMove,
      alternations,
      centerCrossings,
      meanReversion,
      trendCoherence,
    };
  }

  const balanceScore = clamp((balance - MIN_SIDEWAYS_BALANCE) / (1 - MIN_SIDEWAYS_BALANCE), 0, 1);
  const centerScore = 1 - clamp(centerOffset / (boxWidth * 0.2), 0, 1);
  const trendScore = 1 - clamp(trendCoherence / MAX_DIRECTIONAL_TREND_COHERENCE, 0, 1);
  const alternationScore = clamp(
    (alternations - MIN_SIDEWAYS_ALTERNATIONS + 1) / 6,
    0,
    1,
  );
  // A box is stronger when price repeatedly comes back through its own center,
  // not merely when its absolute width happens to be small. This distinguishes
  // an active NEKO-style range from a narrower, drifting band.
  const meanReversionScore = clamp(meanReversion / 0.5, 0, 1);
  const centerCrossingScore = clamp(centerCrossings / 20, 0, 1);
  const sampleScore = 0.6 + 0.4 * clamp(
    (observations.length - MIN_SIDEWAYS_OBSERVATIONS) / (SIDEWAYS_HISTORY_SIZE - MIN_SIDEWAYS_OBSERVATIONS),
    0,
    1,
  );
  return {
    score: clamp(
      sampleScore *
        (0.2 * balanceScore +
          0.16 * centerScore +
          0.17 * trendScore +
          0.1 * alternationScore +
          0.25 * meanReversionScore +
          0.12 * centerCrossingScore),
      0,
      1,
    ),
    boxWidth,
    upwardMove,
    downwardMove,
    alternations,
    centerCrossings,
    meanReversion,
    trendCoherence,
  };
}

/** A range-bound symbol is favored without turning the global event rate into a flood. */
export function sidewaysEventSpawnChance(baseChance: number, highestSidewaysScore: number): number {
  return clamp(baseChance * (1 + 0.35 * clamp(highestSidewaysScore, 0, 1)), 0, 1);
}

/** Weighted targeting makes a high-score symbol more likely than a trend symbol. */
export function sidewaysEventTargetWeight(sidewaysScore: number): number {
  return 1 + 3 * clamp(sidewaysScore, 0, 1);
}

/** Sample a strength, duration, and one-off volume-burst chance from the range score. */
export function sampleHiddenEventProfile(sidewaysScore: number, random: RandomSource): HiddenEventProfile {
  const score = clamp(sidewaysScore, 0, 1);
  const strength =
    MIN_EVENT_STRENGTH +
    (MAX_EVENT_STRENGTH - MIN_EVENT_STRENGTH) * unitRandom(random) ** (1.8 - score);
  const persistence = sampleEventPersistence(strength, score, random);
  const volumeBurstChance = clamp(0.08 + 0.52 * score + 0.12 * strength, 0, 0.85);
  const volumeMultiplier = unitRandom(random) < volumeBurstChance ? 1.25 + 0.75 * strength : 1;
  return { strength, persistence, volumeBurstChance, volumeMultiplier };
}

/** Convert one already-sampled roll without changing the event generator's RNG sequence. */
export function hiddenEventSentimentFromRoll(roll: number): MarketEventSentiment {
  return Number.isFinite(roll) && roll < POSITIVE_EVENT_PROBABILITY ? "POSITIVE" : "NEGATIVE";
}

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
  private readonly eventSpawnChance: number;
  private regime: MarketRegime = "CALM";
  private regimeTicksLeft = 0;
  private marketReturn = 0;
  private marketVariance = REGIME.CALM.marketVolatility ** 2;
  private eventCooldownTicks = 0;

  constructor(symbols: SymbolDef[], options: MarketModelOptions = {}) {
    this.random = options.random ?? { next: () => Math.random() };
    this.eventSpawnChance = clamp(options.eventSpawnChance ?? DEFAULT_EVENT_SPAWN_CHANCE, 0, 1);
    for (const [index, symbol] of symbols.entries()) {
      const restoredPrice = options.initialPrices?.get(symbol.symbol);
      const price = isUsableReferencePrice(restoredPrice) ? restoredPrice : symbol.initialPrice;
      this.states.set(symbol.symbol, {
        price,
        anchor: price,
        previousReturn: 0,
        variance: DEFAULT_PROFILE.idiosyncraticVolatility ** 2,
        events: [],
        sideways: new SidewaysTracker(price),
        marketHistorySeeded: false,
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

    this.maybeStartHiddenEvent();

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
      const eventReturn = this.consumeEventReturn(state);
      const nextReturn = clamp(
        profile.beta * this.marketReturn +
          0.13 * state.previousReturn -
          profile.meanReversion * displacement +
          Math.sqrt(state.variance) * gaussian(this.random) +
          jump +
          eventReturn,
        -0.012,
        0.012,
      );

      state.previousReturn = nextReturn;
      state.price = this.withinDailyBand(Math.exp(nextReturn) * state.price, state.anchor);
      state.anchor = state.anchor * 0.996 + state.price * 0.004;
      // Only durable candles/trades are range observations. The model price is
      // a quote reference and must not manufacture a user-visible box range.
      state.sideways.advance(state.events.length > 0);
    }
  }

  get(symbol: string): number {
    return this.stateFor(symbol).price;
  }

  /**
   * Load the one startup chart history exactly once. It stays local to the
   * bot process and is refused after an event has begun.
   */
  seedMarketHistory(symbol: string, prices: Iterable<number>): boolean {
    const state = this.stateFor(symbol);
    if (state.marketHistorySeeded || state.events.length > 0) return false;
    const observations = state.sideways.seed(prices);
    if (observations === 0) return false;
    state.marketHistorySeeded = true;
    return true;
  }

  /**
   * Observe a new durable trade/candle price. An optional id makes repeated
   * polling safe: the same matching trade is never counted twice.
   */
  observeMarketPrice(symbol: string, price: number, observationId?: string): boolean {
    const state = this.stateFor(symbol);
    if (observationId && state.lastMarketObservationId === observationId) return false;
    if (!isUsableReferencePrice(price)) return false;
    if (observationId) state.lastMarketObservationId = observationId;

    const eventActive = state.events.length > 0;
    const displacement = Math.log(price / state.price);
    // A large, matched price move is information the model did not create.
    // Adopt it outright once no hidden event is in flight so the maker does
    // not recreate an old wall and pull a user-driven breakout back home.
    if (!eventActive && Math.abs(displacement) >= HARD_MARKET_REANCHOR_LOG_RETURN) {
      state.price = price;
      state.anchor = price;
      state.previousReturn = 0;
    } else {
      // Ordinary prints still inform the private quote reference, but in log
      // space and with a small weight so a single inside-the-spread trade does
      // not turn into synthetic trend noise. During an active hidden event,
      // preserve its explicit permanent/temporary split and learn more slowly.
      const priceWeight = eventActive ? EVENT_MARKET_PRICE_BLEND : SOFT_MARKET_PRICE_BLEND;
      const anchorWeight = eventActive ? EVENT_MARKET_ANCHOR_BLEND : SOFT_MARKET_ANCHOR_BLEND;
      state.price = blendLogPrice(state.price, price, priceWeight);
      state.anchor = blendLogPrice(state.anchor, price, anchorWeight);
      state.previousReturn = clamp(displacement * priceWeight, -0.012, 0.012);
    }
    state.sideways.observe(price, state.events.length > 0);
    return true;
  }

  /** Lets the maker avoid overriding an in-flight event with its last print. */
  hasActiveEvent(symbol: string): boolean {
    return this.stateFor(symbol).events.length > 0;
  }

  /**
   * Adds an in-process event to one symbol. This is intentionally not wired to
   * any API: it is used by the stochastic generator below and by deterministic
   * tests only.
   *
   * Part of the impact revalues the anchor permanently, while the rest decays
   * into ordinary order flow. Once that flow fades, the market therefore
   * settles around a new equilibrium instead of snapping back to its old one.
   */
  startEvent(
    symbol: string,
    sentiment: MarketEventSentiment,
    strength: number,
    persistence?: number,
    volumeMultiplier = 1,
  ): void {
    if (!Number.isFinite(strength) || strength < MIN_EVENT_STRENGTH || strength > MAX_EVENT_STRENGTH) {
      throw new Error(`Event strength must be between ${MIN_EVENT_STRENGTH} and ${MAX_EVENT_STRENGTH}`);
    }
    const state = this.stateFor(symbol);
    const retention = persistence ?? sampleEventPersistence(strength, 0, this.random);
    if (!Number.isFinite(retention) || retention <= 0 || retention >= 1) {
      throw new Error("Event persistence must be between 0 and 1");
    }
    if (!Number.isFinite(volumeMultiplier) || volumeMultiplier < 1 || volumeMultiplier > 2) {
      throw new Error("Event volume multiplier must be between 1 and 2");
    }

    const magnitude = MIN_EVENT_LOG_IMPACT + (MAX_EVENT_LOG_IMPACT - MIN_EVENT_LOG_IMPACT) * strength;
    const signedImpact = sentiment === "POSITIVE" ? magnitude : -magnitude;
    const initialImpulse = signedImpact * (1 - PERMANENT_EQUILIBRIUM_SHARE);

    // A good/bad event changes valuation as well as temporary demand. Later
    // events add their own signed revaluation, so a large bad event can
    // overwhelm an earlier good event without needing a special reversal path.
    state.anchor *= Math.exp(signedImpact * PERMANENT_EQUILIBRIUM_SHARE);
    state.sideways.markEventStarted();
    // Event generation has a global cooldown and every impulse decays. Keep
    // each still-active impulse so an overlap fades naturally instead of
    // suddenly deleting the weakest event's flow or volume effect.
    state.events.push({
      initialImpulse,
      remainingImpulse: initialImpulse,
      strength,
      persistence: retention,
      volumeMultiplier,
    });
  }

  /** Current range-bound score, retained inside the bot process only. */
  sidewaysScore(symbol: string): number {
    return this.stateFor(symbol).sideways.assessment().score;
  }

  /** Signed net demand pressure from the still-active hidden events. */
  flowBias(symbol: string): number {
    const pressure = this.stateFor(symbol).events.reduce(
      (sum, event) => sum + this.eventFlowContribution(event),
      0,
    );
    return clamp(pressure, -1, 1);
  }

  /**
   * Events increase trade cadence and quantity as well as side bias. Opposing
   * events can cancel net direction but still create extra volume.
   */
  flowIntensity(symbol: string, baselineIntensity: number): number {
    const baseline = Number.isFinite(baselineIntensity) ? Math.max(0.3, baselineIntensity) : 1;
    const grossPressure = this.stateFor(symbol).events.reduce(
      (sum, event) => sum + this.eventContributionMagnitude(event),
      0,
    );
    const volumeBurstMultiplier = this.stateFor(symbol).events.reduce(
      (largest, event) => Math.max(largest, event.volumeMultiplier),
      1,
    );
    return Math.min(
      MAX_EVENT_FLOW_INTENSITY,
      baseline * (1 + 0.75 * Math.min(1.5, grossPressure)) * volumeBurstMultiplier,
    );
  }

  /** Bias an already-chosen bot side while retaining ordinary strategy noise. */
  chooseFlowSide(symbol: string, neutralSide: OrderSide, random: () => number = Math.random): OrderSide {
    const bias = this.flowBias(symbol);
    if (bias === 0) return neutralSide;

    const preferredSide: OrderSide = bias > 0 ? "BUY" : "SELL";
    if (neutralSide === preferredSide) return neutralSide;
    return random() < Math.abs(bias) * MAX_SIDE_FLIP_CHANCE ? preferredSide : neutralSide;
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

  private stateFor(symbol: string): PriceState {
    const state = this.states.get(symbol);
    if (!state) throw new Error("Unknown symbol: " + symbol);
    return state;
  }

  /** Generate at most one rare event after a 2–4 minute cooldown. */
  private maybeStartHiddenEvent() {
    if (this.eventCooldownTicks > 0) {
      this.eventCooldownTicks--;
      return;
    }
    const symbols = [...this.states.keys()];
    if (symbols.length === 0) return;
    const sidewaysScores = new Map(symbols.map((symbol) => [symbol, this.sidewaysScore(symbol)]));
    const highestScore = Math.max(...sidewaysScores.values());
    const spawnChance = sidewaysEventSpawnChance(this.eventSpawnChance, highestScore);
    if (spawnChance <= 0 || this.random.next() >= spawnChance) return;

    const target = chooseWeightedEventTarget(symbols, sidewaysScores, this.random);
    const sidewaysScore = sidewaysScores.get(target) ?? 0;
    const sentiment = hiddenEventSentimentFromRoll(unitRandom(this.random));
    const profile = sampleHiddenEventProfile(sidewaysScore, this.random);
    this.startEvent(target, sentiment, profile.strength, profile.persistence, profile.volumeMultiplier);
    this.eventCooldownTicks = randomInt(this.random, EVENT_COOLDOWN_MIN_TICKS, EVENT_COOLDOWN_MAX_TICKS);
  }

  /** Apply each transient impulse gradually, then retire it once negligible. */
  private consumeEventReturn(state: PriceState): number {
    let eventReturn = 0;
    state.events = state.events.filter((event) => {
      eventReturn += event.remainingImpulse * (1 - event.persistence);
      event.remainingImpulse *= event.persistence;
      return Math.abs(event.remainingImpulse) >= MIN_REMAINING_EVENT_IMPULSE;
    });
    return eventReturn;
  }

  private eventFlowContribution(event: HiddenMarketEvent): number {
    return Math.sign(event.initialImpulse) * event.strength * Math.abs(event.remainingImpulse / event.initialImpulse);
  }

  private eventContributionMagnitude(event: HiddenMarketEvent): number {
    return Math.abs(this.eventFlowContribution(event));
  }
}

function chooseWeightedEventTarget(
  symbols: readonly string[],
  sidewaysScores: ReadonlyMap<string, number>,
  random: RandomSource,
): string {
  const weights = symbols.map((symbol) => sidewaysEventTargetWeight(sidewaysScores.get(symbol) ?? 0));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let cursor = unitRandom(random) * totalWeight;
  for (const [index, symbol] of symbols.entries()) {
    cursor -= weights[index];
    if (cursor < 0) return symbol;
  }
  return symbols.at(-1)!;
}

/** Stronger and more range-bound events skew toward a longer, but still bounded, life. */
function sampleEventPersistence(strength: number, sidewaysScore: number, random: RandomSource): number {
  const center = 0.936 + strength * 0.045 + clamp(sidewaysScore, 0, 1) * 0.005;
  const jitter = (unitRandom(random) - 0.5) * 0.018;
  return clamp(center + jitter, 0.9, 0.99);
}

function quantile(sorted: readonly number[], percentile: number): number {
  const position = clamp(percentile, 0, 1) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/** Robustly estimate the center of a box without letting a single wick move it. */
function robustRangeCenter(prices: readonly number[]): number {
  const logs = prices
    .filter((price) => Number.isFinite(price) && price > 0)
    .map((price) => Math.log(price))
    .sort((left, right) => left - right);
  if (logs.length === 0) return 1;
  return Math.exp((quantile(logs, 0.1) + quantile(logs, 0.9)) / 2);
}

function linearTrendSpan(values: readonly number[]): number {
  const meanX = (values.length - 1) / 2;
  const meanY = values.reduce((sum, value) => sum + value, 0) / values.length;
  let numerator = 0;
  let denominator = 0;
  for (const [index, value] of values.entries()) {
    const x = index - meanX;
    numerator += x * (value - meanY);
    denominator += x * x;
  }
  return denominator === 0 ? 0 : Math.abs((numerator / denominator) * (values.length - 1));
}

/**
 * A short moving average reveals a channel's steadily moving center while
 * filtering the ordinary up/down visits that define a box range.
 */
function smoothedTrendCoherence(values: readonly number[]): number {
  const radius = 4;
  const smoothed = values.map((_, index) => {
    const start = Math.max(0, index - radius);
    const end = Math.min(values.length, index + radius + 1);
    const window = values.slice(start, end);
    return window.reduce((sum, value) => sum + value, 0) / window.length;
  });
  return Math.abs(pearsonCorrelation(smoothed.map((_, index) => index), smoothed));
}

function countRangeAlternations(deviations: readonly number[], threshold: number): number {
  let lastSide = 0;
  let alternations = 0;
  for (const deviation of deviations) {
    const side = deviation >= threshold ? 1 : deviation <= -threshold ? -1 : 0;
    if (side === 0 || side === lastSide) continue;
    if (lastSide !== 0) alternations++;
    lastSide = side;
  }
  return alternations;
}

/** Count genuine passages through the fixed equilibrium, ignoring exact-center ticks. */
function countCenterCrossings(deviations: readonly number[]): number {
  let lastSide = 0;
  let crossings = 0;
  for (const deviation of deviations) {
    const side = Math.sign(deviation);
    if (side === 0 || side === lastSide) continue;
    if (lastSide !== 0) crossings++;
    lastSide = side;
  }
  return crossings;
}

/**
 * Positive values indicate that a displacement from equilibrium predicts a
 * move back toward it on the next observation. Correlation keeps the signal
 * scale-free across cheap and expensive symbols.
 */
function meanReversionStrength(deviations: readonly number[]): number {
  if (deviations.length < 3) return 0;
  const previous = deviations.slice(0, -1);
  const nextMoves = deviations.slice(1).map((value, index) => value - deviations[index]);
  return clamp(-pearsonCorrelation(previous, nextMoves), 0, 1);
}

function pearsonCorrelation(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  const leftMean = left.reduce((sum, value) => sum + value, 0) / left.length;
  const rightMean = right.reduce((sum, value) => sum + value, 0) / right.length;
  let numerator = 0;
  let leftSumSquares = 0;
  let rightSumSquares = 0;
  for (const [index, value] of left.entries()) {
    const leftDelta = value - leftMean;
    const rightDelta = right[index] - rightMean;
    numerator += leftDelta * rightDelta;
    leftSumSquares += leftDelta * leftDelta;
    rightSumSquares += rightDelta * rightDelta;
  }
  const denominator = Math.sqrt(leftSumSquares * rightSumSquares);
  return denominator === 0 ? 0 : numerator / denominator;
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
  return Math.floor(unitRandom(random) * (max - min + 1)) + min;
}

/** Blend strictly positive prices without a high-priced symbol dominating arithmetic averaging. */
function blendLogPrice(current: number, observed: number, weight: number): number {
  const boundedWeight = clamp(weight, 0, 1);
  return Math.exp(Math.log(current) * (1 - boundedWeight) + Math.log(observed) * boundedWeight);
}

function unitRandom(random: RandomSource): number {
  return clamp(random.next(), 0, 0.999_999);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
