import {
  liquidityTotalQtyForPrice,
  type OrderSide,
  type SymbolDef,
} from "@mock-kabu/shared";

/**
 * A compact, dense liquidity ladder for the market-maker bots.
 *
 * Quantities are normalised by the quote center's notional value, rather than
 * being fixed share counts. This makes a ₩8,000 symbol carry more shares than
 * a ₩300,000 symbol while keeping comparable money on each side of the book.
 *
 * Consecutive offsets are intentional: after a one-tick recenter eleven of
 * twelve prices on each side are still valid. The maker can therefore slide a
 * dense wall with two edge replacements instead of churning all 24 orders.
 */
// Keep four spare levels outside the UI's 10-row snapshot.  A normal market
// order can therefore consume several inner quotes while each visible side
// still retains the required eight executable levels until the fast refill
// loop observes the fill.
export const LIQUIDITY_DISTANCE_TICKS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;
/** Relative distribution only; actual share quantities depend on price. */
export const LIQUIDITY_LEVEL_WEIGHTS = [160, 140, 120, 100, 85, 70, 60, 50, 45, 40, 35, 30] as const;
/** Small ordinary market orders should not exhaust the best quote by default. */
export const LIQUIDITY_MIN_BEST_QTY = 80;
/** SAKU keeps more of its existing side budget at the executable price. */
export const SAKU_MIN_BEST_QTY = 100;
/** Normalise legacy 80-share SAKU best walls promptly without replacing after every small fill. */
export const SAKU_BEST_REFILL_LOW_WATER_RATIO = 0.82;
const LIQUIDITY_WEIGHT_TOTAL = LIQUIDITY_LEVEL_WEIGHTS.reduce((sum, weight) => sum + weight, 0);
/** The REST/UI order book exposes the nearest ten price levels per side. */
export const VISIBLE_LIQUIDITY_LEVELS = 10;
/** Bound fresh opposite-side expansion when a historical partial is extreme. */
export const GUARD_AWARE_VISIBLE_TARGET_CAP_MULTIPLIER = 2;

export interface LiquidityQuote {
  side: OrderSide;
  level: number;
  price: number;
  qty: number;
  /** Higher only for SAKU's near-price best wall; consumed by the maker refill check. */
  refillLowWaterRatio?: number;
}

/** A durable PARTIAL row which remains in the book while fresh depth is added. */
export type PreservedLiquidityQuote = Pick<LiquidityQuote, "side" | "price" | "qty">;

export interface LiquidityLadderOptions {
  /**
   * Historical PARTIAL rows are never cancelled automatically. Their visible
   * notional is subtracted from fresh depth so the two sources do not stack.
   */
  preserved?: Iterable<PreservedLiquidityQuote>;
}

export interface GuardAwareLiquidityLadder {
  quotes: LiquidityQuote[];
  defaultVisibleTargetNotional: number;
  uncappedTargetVisibleNotional: number;
  targetVisibleNotional: number;
  preservedVisibleNotional: Record<OrderSide, number>;
  freshVisibleBudget: Record<OrderSide, number>;
  freshVisibleNotional: Record<OrderSide, number>;
}

/** A quote-center can move by at most this many ticks before old quotes retire. */
export const MAX_RECENTER_TICKS = 1;

export function liquidityTotalQty(centerPrice: number): number {
  return liquidityTotalQtyForPrice(centerPrice);
}

/**
 * Split a price-normalised total across the twelve levels without losing a
 * share to rounding.  The small best-wall floor protects the ordinary 1..48
 * share flow even for high-priced symbols whose total ladder is compact.
 */
function liquidityQtyByLevelForProfile(
  total: number,
  minimumBestQty: number,
  preserveNearDepth = false,
): number[] {
  const raw = LIQUIDITY_LEVEL_WEIGHTS.map((weight) => (weight / LIQUIDITY_WEIGHT_TOTAL) * total);
  const quantities = raw.map((value) => Math.floor(value));
  let remainder = total - quantities.reduce((sum, qty) => sum + qty, 0);

  const fractionalOrder = raw
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (const { index } of fractionalOrder) {
    if (remainder <= 0) break;
    quantities[index]++;
    remainder--;
  }

  const bestFloor = Math.min(minimumBestQty, total - (LIQUIDITY_DISTANCE_TICKS.length - 1));
  let shortfall = Math.max(0, bestFloor - quantities[0]);
  while (shortfall > 0) {
    let donor = -1;
    if (preserveNearDepth) {
      // SAKU has a compact 160-share side. Taking from the far edge first
      // makes the first three executable prices visibly thicker instead of
      // flattening all eleven remaining levels to nearly the same size.
      for (let index = quantities.length - 1; index >= 1; index--) {
        if (quantities[index] > 1) {
          donor = index;
          break;
        }
      }
    } else {
      donor = 1;
      for (let index = 2; index < quantities.length; index++) {
        if (quantities[index] > quantities[donor]) donor = index;
      }
    }
    // `bestFloor` leaves at least one share for every remaining level.
    if (donor < 0 || quantities[donor] <= 1) break;
    quantities[donor]--;
    quantities[0]++;
    shortfall--;
  }

  return quantities;
}

/** Standard price-normalised ladder quantities, retained for non-SAKU callers. */
export function liquidityQtyByLevel(centerPrice: number): number[] {
  return liquidityQtyByLevelForProfile(liquidityTotalQty(centerPrice), LIQUIDITY_MIN_BEST_QTY);
}

/** SAKU concentrates its unchanged side budget at the executable near-price rungs. */
export function liquidityQtyByLevelForSymbol(def: SymbolDef, centerPrice: number): number[] {
  const isSaku = def.symbol === "SAKU";
  return liquidityQtyByLevelForProfile(
    liquidityTotalQty(centerPrice),
    isSaku ? SAKU_MIN_BEST_QTY : LIQUIDITY_MIN_BEST_QTY,
    isSaku,
  );
}

/** The required best-wall size is profile-aware so taker sizing and quotes agree. */
export function liquidityMinimumBestQty(def: SymbolDef): number {
  return def.symbol === "SAKU" ? SAKU_MIN_BEST_QTY : LIQUIDITY_MIN_BEST_QTY;
}

/** The executable best-wall quantity for price-scaled taker flow. */
export function liquidityBestWallQty(def: SymbolDef, centerPrice: number): number {
  return liquidityQtyByLevelForSymbol(def, alignToTick(centerPrice, def.tickSize))[0];
}

/** Aligns a reference value to the exchange tick grid. */
export function alignToTick(price: number, tickSize: number): number {
  if (!Number.isFinite(price) || !Number.isSafeInteger(tickSize) || tickSize <= 0) {
    throw new Error("price and tickSize must be positive finite values");
  }
  return Math.max(tickSize, Math.round(price / tickSize) * tickSize);
}

/**
 * Move a quote center gradually.  A one-tick shift keeps the replacement
 * ladder strictly outside its previous opposite-side best price, so both
 * ladders can coexist briefly without a self-trade.
 */
export function moveQuoteCenter(
  currentCenter: number,
  targetCenter: number,
  tickSize: number,
  maxStepTicks = MAX_RECENTER_TICKS,
): number {
  const current = alignToTick(currentCenter, tickSize);
  const target = alignToTick(targetCenter, tickSize);
  const maxStep = tickSize * Math.max(1, Math.floor(maxStepTicks));
  const delta = target - current;
  if (Math.abs(delta) <= maxStep) return target;
  return current + Math.sign(delta) * maxStep;
}

function liquidityQuote(
  def: SymbolDef,
  side: OrderSide,
  level: number,
  price: number,
  qty: number,
): LiquidityQuote {
  return {
    side,
    level,
    price,
    qty,
    ...(def.symbol === "SAKU" && level === 0
      ? { refillLowWaterRatio: SAKU_BEST_REFILL_LOW_WATER_RATIO }
      : {}),
  };
}

/** The original symmetric ladder; keep this exact path when no PARTIAL exists. */
function buildBaseLiquidityLadder(def: SymbolDef, centerPrice: number): LiquidityQuote[] {
  const center = alignToTick(centerPrice, def.tickSize);
  const quantities = liquidityQtyByLevelForSymbol(def, center);
  const quotes: LiquidityQuote[] = [];

  for (let level = 0; level < LIQUIDITY_DISTANCE_TICKS.length; level++) {
    const offset = LIQUIDITY_DISTANCE_TICKS[level] * def.tickSize;
    const bid = center - offset;
    const ask = center + offset;
    const qty = quantities[level];

    // The seeded symbols are far above one tick.  Retaining this guard keeps
    // the helper correct if a future low-priced symbol is added.
    if (bid >= def.tickSize) {
      quotes.push(liquidityQuote(def, "BUY", level, bid, qty));
    }
    quotes.push(liquidityQuote(def, "SELL", level, ask, qty));
  }

  return quotes;
}

function visibleSideQuotes(quotes: Iterable<LiquidityQuote>, side: OrderSide): LiquidityQuote[] {
  return [...quotes]
    .filter((quote) => quote.side === side)
    .sort((left, right) => (side === "BUY" ? right.price - left.price : left.price - right.price))
    .slice(0, VISIBLE_LIQUIDITY_LEVELS);
}

/** Fresh visible notional only, before any preserved PARTIAL amount is added. */
export function visibleLadderNotional(quotes: Iterable<LiquidityQuote>, side: OrderSide): number {
  return visibleSideQuotes(quotes, side).reduce((sum, quote) => sum + quote.price * quote.qty, 0);
}

/**
 * Calculate the PARTIAL amount which can actually appear in the UI's ten
 * levels. Fresh ladders always leave one or more shares at their ten nearest
 * prices, so merging those prices with guarded rows gives an exact visibility
 * test without needing a live order-book snapshot.
 */
export function preservedVisibleNotional(
  def: SymbolDef,
  centerPrice: number,
  preserved: Iterable<PreservedLiquidityQuote>,
): Record<OrderSide, number> {
  const center = alignToTick(centerPrice, def.tickSize);
  const guards = [...preserved].filter(
    (quote) =>
      Number.isSafeInteger(quote.price) &&
      quote.price > 0 &&
      Number.isSafeInteger(quote.qty) &&
      quote.qty > 0,
  );
  const result: Record<OrderSide, number> = { BUY: 0, SELL: 0 };

  for (const side of ["BUY", "SELL"] as const) {
    const freshPrices = new Set<number>();
    for (let level = 0; level < VISIBLE_LIQUIDITY_LEVELS; level++) {
      const offset = LIQUIDITY_DISTANCE_TICKS[level] * def.tickSize;
      const price = side === "BUY" ? center - offset : center + offset;
      if (side === "SELL" || price >= def.tickSize) freshPrices.add(price);
    }

    const preservedQtyByPrice = new Map<number, number>();
    for (const quote of guards) {
      if (quote.side !== side) continue;
      preservedQtyByPrice.set(quote.price, (preservedQtyByPrice.get(quote.price) ?? 0) + quote.qty);
      freshPrices.add(quote.price);
    }
    const visiblePrices = [...freshPrices]
      .sort((left, right) => (side === "BUY" ? right - left : left - right))
      .slice(0, VISIBLE_LIQUIDITY_LEVELS);
    result[side] = visiblePrices.reduce(
      (sum, price) => sum + price * (preservedQtyByPrice.get(price) ?? 0),
      0,
    );
  }

  return result;
}

function sidePrice(def: SymbolDef, center: number, side: OrderSide, level: number): number {
  const offset = LIQUIDITY_DISTANCE_TICKS[level] * def.tickSize;
  return side === "BUY" ? center - offset : center + offset;
}

/**
 * Allocate fresh shares for one side after durable partial notional has been
 * accounted for. Every one of the twelve rungs retains at least one share;
 * the outer pair is deliberately a one-share gap cushion outside the UI.
 */
function guardAwareSideQuantities(
  def: SymbolDef,
  center: number,
  side: OrderSide,
  freshVisibleBudget: number,
  minimumBestQty: number,
): number[] {
  const visiblePrices = Array.from({ length: VISIBLE_LIQUIDITY_LEVELS }, (_, level) =>
    sidePrice(def, center, side, level),
  );
  const minimumVisibleNotional = visiblePrices.reduce(
    (sum, price, level) => sum + Math.max(def.tickSize, price) * (level === 0 ? minimumBestQty : 1),
    0,
  );
  const quantities = LIQUIDITY_DISTANCE_TICKS.map((_, level) =>
    level < VISIBLE_LIQUIDITY_LEVELS ? (level === 0 ? minimumBestQty : 1) : 1,
  );
  // The best-wall safety floor can be more than a small SAKU-sized residual
  // budget. In that case the floor is the only intentional overage; otherwise
  // distribute just the remaining notional instead of scaling a second full
  // weighted ladder on top of it.
  const remainingBudget = Math.max(0, freshVisibleBudget - minimumVisibleNotional);
  const weightedNotional = visiblePrices.reduce(
    (sum, price, level) => sum + Math.max(def.tickSize, price) * LIQUIDITY_LEVEL_WEIGHTS[level],
    0,
  );
  const rawExtras = visiblePrices.map((_, level) =>
    weightedNotional > 0 ? (LIQUIDITY_LEVEL_WEIGHTS[level] * remainingBudget) / weightedNotional : 0,
  );
  for (let level = 0; level < VISIBLE_LIQUIDITY_LEVELS; level++) {
    quantities[level] += Math.floor(rawExtras[level]);
  }

  // Floor rounding leaves fewer than ten shares' worth of value. Allocate
  // those one at a time in fractional-weight order without crossing the
  // requested fresh budget. This keeps ordinary guarded ladders close to the
  // shared visible target, rather than systematically oversizing them.
  let unallocated = Math.max(
    0,
    freshVisibleBudget -
      visiblePrices.reduce((sum, price, level) => sum + price * quantities[level], 0),
  );
  const fractionalOrder = rawExtras
    .map((value, level) => ({ level, fraction: value - Math.floor(value) }))
    .sort((left, right) => right.fraction - left.fraction || left.level - right.level);
  while (unallocated >= Math.min(...visiblePrices)) {
    const candidate = fractionalOrder.find(({ level }) => visiblePrices[level] <= unallocated);
    if (!candidate) break;
    quantities[candidate.level]++;
    unallocated -= visiblePrices[candidate.level];
  }
  return quantities;
}

/**
 * Build a side-aware fresh ladder around existing durable PARTIALs. The
 * target is the largest of the ordinary fresh visible depth and either side's
 * visible partial amount, so a high resistance/support does not make the
 * opposite side artificially thin. Fresh expansion is capped at 2x normal
 * visible depth; a historical partial already above that cap stays untouched.
 */
export function buildGuardAwareLiquidityLadder(
  def: SymbolDef,
  centerPrice: number,
  preserved: Iterable<PreservedLiquidityQuote>,
): GuardAwareLiquidityLadder {
  const center = alignToTick(centerPrice, def.tickSize);
  const guardList = [...preserved].filter(
    (quote) =>
      Number.isSafeInteger(quote.price) &&
      quote.price > 0 &&
      Number.isSafeInteger(quote.qty) &&
      quote.qty > 0,
  );
  const defaultQuotes = buildBaseLiquidityLadder(def, center);
  const defaultVisibleTargetNotional = Math.max(
    visibleLadderNotional(defaultQuotes, "BUY"),
    visibleLadderNotional(defaultQuotes, "SELL"),
  );
  const preservedVisible = preservedVisibleNotional(def, center, guardList);
  const uncappedTargetVisibleNotional = Math.max(
    defaultVisibleTargetNotional,
    preservedVisible.BUY,
    preservedVisible.SELL,
  );
  const targetVisibleNotional = Math.min(
    uncappedTargetVisibleNotional,
    defaultVisibleTargetNotional * GUARD_AWARE_VISIBLE_TARGET_CAP_MULTIPLIER,
  );
  const freshVisibleBudget: Record<OrderSide, number> = {
    BUY: Math.max(0, targetVisibleNotional - preservedVisible.BUY),
    SELL: Math.max(0, targetVisibleNotional - preservedVisible.SELL),
  };
  const requiredBestQty = liquidityMinimumBestQty(def);
  const minimumBestQty = (side: OrderSide): number => {
    const bestPrice = sidePrice(def, center, side, 0);
    const preservedAtBest = guardList
      .filter((quote) => quote.side === side && quote.price === bestPrice)
      .reduce((sum, quote) => sum + quote.qty, 0);
    return preservedAtBest >= requiredBestQty ? 1 : requiredBestQty;
  };
  const quantitiesBySide: Record<OrderSide, number[]> = {
    BUY: guardAwareSideQuantities(def, center, "BUY", freshVisibleBudget.BUY, minimumBestQty("BUY")),
    SELL: guardAwareSideQuantities(def, center, "SELL", freshVisibleBudget.SELL, minimumBestQty("SELL")),
  };
  const quotes: LiquidityQuote[] = [];
  for (let level = 0; level < LIQUIDITY_DISTANCE_TICKS.length; level++) {
    const bid = sidePrice(def, center, "BUY", level);
    if (bid >= def.tickSize) {
      quotes.push(liquidityQuote(def, "BUY", level, bid, quantitiesBySide.BUY[level]));
    }
    quotes.push(
      liquidityQuote(
        def,
        "SELL",
        level,
        sidePrice(def, center, "SELL", level),
        quantitiesBySide.SELL[level],
      ),
    );
  }

  return {
    quotes,
    defaultVisibleTargetNotional,
    uncappedTargetVisibleNotional,
    targetVisibleNotional,
    preservedVisibleNotional: preservedVisible,
    freshVisibleBudget,
    freshVisibleNotional: {
      BUY: visibleLadderNotional(quotes, "BUY"),
      SELL: visibleLadderNotional(quotes, "SELL"),
    },
  };
}

/**
 * Produces a non-crossing two-sided quote ladder around a tick-aligned center.
 * With no durable PARTIAL rows this returns the original symmetric ladder
 * exactly. When such rows exist, their visible notional is budgeted first.
 */
export function buildLiquidityLadder(
  def: SymbolDef,
  centerPrice: number,
  options: LiquidityLadderOptions = {},
): LiquidityQuote[] {
  const preserved = [...(options.preserved ?? [])].filter((quote) => quote.qty > 0);
  if (preserved.length === 0) return buildBaseLiquidityLadder(def, centerPrice);
  return buildGuardAwareLiquidityLadder(def, centerPrice, preserved).quotes;
}

/** True when adding `candidate` cannot match any tracked quote from this maker. */
export function canAddWithoutSelfTrade(
  candidate: Pick<LiquidityQuote, "side" | "price">,
  existing: Iterable<Pick<LiquidityQuote, "side" | "price">>,
): boolean {
  for (const quote of existing) {
    if (candidate.side === quote.side) continue;
    if (candidate.side === "BUY" && candidate.price >= quote.price) return false;
    if (candidate.side === "SELL" && candidate.price <= quote.price) return false;
  }
  return true;
}

/**
 * Checks the whole old/new ladder pair.  It is useful both as a regression
 * guard and as documentation for why a single-tick recenter is intentional.
 */
export function canLaddersCoexist(
  current: Iterable<LiquidityQuote>,
  next: Iterable<LiquidityQuote>,
): boolean {
  const existing = [...current];
  return [...next].every((quote) => canAddWithoutSelfTrade(quote, existing));
}
