import type { OrderbookSnapshot, SymbolDef } from "@mock-kabu/shared";
import { ApiClient, isRejection, type LiveOrder } from "./client";
import {
  alignToTick,
  buildLiquidityLadder,
  canAddWithoutSelfTrade,
  LIQUIDITY_DISTANCE_TICKS,
  moveQuoteCenter,
  type LiquidityQuote,
} from "./liquidity";
import type { MarketModel } from "./market-model";

export type ManagedQuote = LiquidityQuote & {
  id: string;
  /** A reused rung awaiting one safe normalising replacement. */
  needsNormalization?: boolean;
};
/** A live row waiting for a post-before-cancel retirement. */
export type RetirableQuote = Pick<LiquidityQuote, "side" | "price" | "qty"> & { id: string };
/** A non-terminal historical PARTIAL kept as both a price boundary and depth. */
export type PreservedOrderGuard = Pick<LiquidityQuote, "side" | "price" | "qty"> & { id: string };

export interface MarketMakerOptions {
  /**
   * Dedicated bot16..bot20 only: if a prior reserve order cannot become
   * terminal, preserve it as a guard and build a fresh non-crossing ladder.
   * Generic/legacy makers deliberately retain the fail-closed behavior.
   */
  allowUnretirableReserveFallback?: boolean;
}

/** Raised only when an inherited account cannot clear its legacy live orders. */
export class MarketMakerStartupBlockedError extends Error {}

// The reserve owns twelve levels per side, while the REST snapshot exposes
// ten.  Reconcile substantially faster than the visible cushion can be
// consumed so a single ordinary market order never leaves a side below eight.
const QUOTE_RECONCILE_MS = 140;
/** Snapshot depth is a budget hint, not a trading dependency. */
const PRESERVED_DEPTH_REFRESH_MS = 500;
const STARTUP_CANCEL_TIMEOUT_MS = 5_000;
const MIN_ADOPTABLE_LEVELS_PER_SIDE = 8;
/** A partial rung is topped up only after material depletion, not every fill. */
const REFILL_LOW_WATER_RATIO = 0.45;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function quoteKey(quote: Pick<LiquidityQuote, "side" | "level">): string {
  return `${quote.side}:${quote.level}`;
}

function depthKey(quote: Pick<LiquidityQuote, "side" | "price">): string {
  return `${quote.side}:${quote.price}`;
}

/**
 * A snapshot-verified subset of preserved PARTIAL rows is real displayed
 * depth. Raw guards remain separate self-trade boundaries even when a stale
 * database row is absent from the matching-engine snapshot.
 */
function buildMarketMakerPlan(
  def: SymbolDef,
  center: number,
  budgetedPreserved: ReadonlyMap<string, PreservedOrderGuard>,
): LiquidityQuote[] {
  return buildLiquidityLadder(def, center, { preserved: budgetedPreserved.values() });
}

/**
 * Snapshot levels are aggregate quantities, while a bot tracks its own fresh
 * and cancellation-pending rows independently. Remove those known rows first,
 * then allocate only the remaining visible amount across durable PARTIAL
 * guards. An unknown or empty snapshot intentionally produces no budgeted
 * guard depth: a complete fresh wall is safer than underfilling the book.
 */
export function budgetPreservedGuardsFromSnapshot(
  preserved: Iterable<PreservedOrderGuard>,
  snapshot: Pick<OrderbookSnapshot, "bids" | "asks"> | null | undefined,
  ownQuotes: Iterable<Pick<LiquidityQuote, "side" | "price" | "qty">> = [],
): Map<string, PreservedOrderGuard> {
  if (!snapshot) return new Map();

  const available = new Map<string, number>();
  const addSnapshotLevels = (side: "BUY" | "SELL", levels: OrderbookSnapshot["bids"]) => {
    for (const level of levels) {
      if (!Number.isSafeInteger(level.price) || level.price <= 0 || !Number.isSafeInteger(level.qty) || level.qty <= 0) {
        continue;
      }
      const key = depthKey({ side, price: level.price });
      available.set(key, (available.get(key) ?? 0) + level.qty);
    }
  };
  addSnapshotLevels("BUY", snapshot.bids);
  addSnapshotLevels("SELL", snapshot.asks);

  for (const quote of ownQuotes) {
    if (
      !Number.isSafeInteger(quote.price) ||
      quote.price <= 0 ||
      !Number.isSafeInteger(quote.qty) ||
      quote.qty <= 0
    ) {
      continue;
    }
    const key = depthKey(quote);
    available.set(key, Math.max(0, (available.get(key) ?? 0) - quote.qty));
  }

  const budgeted = new Map<string, PreservedOrderGuard>();
  for (const guard of preserved) {
    if (
      !Number.isSafeInteger(guard.price) ||
      guard.price <= 0 ||
      !Number.isSafeInteger(guard.qty) ||
      guard.qty <= 0
    ) {
      continue;
    }
    const key = depthKey(guard);
    const visibleQty = Math.min(guard.qty, available.get(key) ?? 0);
    if (visibleQty <= 0) continue;
    budgeted.set(guard.id, { ...guard, qty: visibleQty });
    available.set(key, (available.get(key) ?? 0) - visibleQty);
  }
  return budgeted;
}

/** Drop stale budget entries as raw guards become terminal or are filled. */
function clampBudgetedPreservedGuards(
  preserved: ReadonlyMap<string, PreservedOrderGuard>,
  budgeted: Map<string, PreservedOrderGuard>,
): void {
  for (const [id, quote] of budgeted) {
    const raw = preserved.get(id);
    if (!raw || raw.qty <= 0) {
      budgeted.delete(id);
      continue;
    }
    if (quote.qty > raw.qty || quote.side !== raw.side || quote.price !== raw.price) {
      budgeted.set(id, { ...raw, qty: Math.min(raw.qty, quote.qty) });
    }
  }
}

function ownBookQuotes(
  active: Map<string, ManagedQuote>,
  retiring: Map<string, ManagedQuote>,
  retirable: Map<string, RetirableQuote>,
): Array<Pick<LiquidityQuote, "side" | "price" | "qty">> {
  return [...active.values(), ...retiring.values(), ...retirable.values()];
}

async function refreshBudgetedPreservedGuards(
  client: ApiClient,
  symbol: string,
  active: Map<string, ManagedQuote>,
  retiring: Map<string, ManagedQuote>,
  preserved: Map<string, PreservedOrderGuard>,
  retirable: Map<string, RetirableQuote>,
  budgeted: Map<string, PreservedOrderGuard>,
): Promise<void> {
  if (preserved.size === 0) {
    budgeted.clear();
    return;
  }
  try {
    const snapshot = await client.orderbook(symbol);
    const next = budgetPreservedGuardsFromSnapshot(
      preserved.values(),
      snapshot,
      ownBookQuotes(active, retiring, retirable),
    );
    budgeted.clear();
    for (const [id, guard] of next) budgeted.set(id, guard);
  } catch {
    // Do not reuse unverified historical depth after a snapshot failure.
    // A temporary full fresh wall is safe; the raw PARTIAL remains a boundary.
    budgeted.clear();
  }
}

function trackedQuotes(
  active: Map<string, ManagedQuote>,
  retiring: Map<string, ManagedQuote>,
  preserved: Iterable<PreservedOrderGuard> = [],
  retirable: Iterable<RetirableQuote> = [],
): Array<Pick<LiquidityQuote, "side" | "price">> {
  return [...active.values(), ...retiring.values(), ...preserved, ...retirable];
}

export function isQuoteSufficient(current: ManagedQuote | undefined, desired: LiquidityQuote): boolean {
  if (!current || current.price !== desired.price) return false;
  if (current.needsNormalization) return false;
  return current.qty >= Math.max(1, Math.ceil(desired.qty * REFILL_LOW_WATER_RATIO));
}

/**
 * A one-tick slide on a consecutive ladder leaves eleven prices per side in
 * place. Re-key those live rows by their new level and return only the two
 * obsolete edge rows. Keeping them as explicit superseded guards until the
 * new edges exist makes the transition gap-free and self-trade-safe.
 */
export function remapActiveQuotesForPlan(
  active: Map<string, ManagedQuote>,
  plan: LiquidityQuote[],
): RetirableQuote[] {
  const bySideAndPrice = new Map<string, ManagedQuote[]>();
  for (const quote of active.values()) {
    const key = `${quote.side}:${quote.price}`;
    const matches = bySideAndPrice.get(key) ?? [];
    matches.push(quote);
    bySideAndPrice.set(key, matches);
  }

  const remapped = new Map<string, ManagedQuote>();
  for (const desired of plan) {
    const candidates = bySideAndPrice.get(`${desired.side}:${desired.price}`);
    const current = candidates?.shift();
    if (current) {
      remapped.set(quoteKey(desired), {
        ...current,
        level: desired.level,
        // A formerly inner/best quote can land on a smaller outer rung after
        // a one-tick slide. Reusing its identity is safe, but reusing the
        // oversized quantity would permanently inflate visible notional.
        // Existing normalisation requests (including inherited fixed-size
        // rows) must survive every re-key as well.
        needsNormalization: current.needsNormalization || current.qty > desired.qty || undefined,
      });
    }
  }

  const superseded = [...bySideAndPrice.values()]
    .flat()
    .map(({ id, side, price, qty }) => ({ id, side, price, qty }));
  active.clear();
  for (const [key, quote] of remapped) active.set(key, quote);
  return superseded;
}

function canPlanCoexist(
  plan: Iterable<LiquidityQuote>,
  active: Map<string, ManagedQuote>,
  retiring: Map<string, ManagedQuote>,
  preserved: Iterable<PreservedOrderGuard>,
  retirable: Iterable<RetirableQuote>,
): boolean {
  const boundaries: Array<Pick<LiquidityQuote, "side" | "price">> = trackedQuotes(
    active,
    retiring,
    preserved,
    retirable,
  );
  for (const quote of plan) {
    if (!canAddWithoutSelfTrade(quote, boundaries)) return false;
    boundaries.push(quote);
  }
  return true;
}

/**
 * A restarted bots process can inherit quotes from its previous process.  The
 * DELETE endpoint is asynchronous, so wait until the durable order state is
 * terminal before adding a new ladder for the same account and symbol.
 */
async function retirePreviousQuotes(
  client: ApiClient,
  symbol: string,
  initialLive?: LiveOrder[],
): Promise<void> {
  const deadline = Date.now() + STARTUP_CANCEL_TIMEOUT_MS;
  const lastCancelRequest = new Map<string, number>();
  let live = initialLive;
  while (true) {
    live ??= await client.myLiveOrders(symbol);
    if (live.length === 0) return;

    const now = Date.now();
    for (const order of live) {
      // The API keeps an order active until its asynchronous order.closed
      // event settles. Re-sending DELETE every 200ms creates duplicate close
      // events, so retry a genuinely stuck cancellation at a bounded cadence.
      if (now - (lastCancelRequest.get(order.id) ?? 0) < 1_000) continue;
      try {
        await client.cancelOrder(order.id);
        lastCancelRequest.set(order.id, now);
      } catch (error) {
        // A fill racing with the cancel request is safe.  The polling loop
        // below still waits for the terminal state instead of assuming it.
        if (!isRejection(error)) throw error;
        lastCancelRequest.set(order.id, now);
      }
    }

    if (Date.now() >= deadline) {
      throw new MarketMakerStartupBlockedError(`[mm:${symbol}] previous quotes did not retire before timeout`);
    }
    await sleep(200);
    live = undefined;
  }
}

function remainingQty(order: LiveOrder): number {
  return Math.max(0, order.qty - order.filledQty);
}

/**
 * Keep one guard per executable live order ID.  A Map prevents a stale order
 * from being added twice when startup polling returns the same PARTIAL row.
 */
export function unretirableReserveGuards(live: LiveOrder[]): Map<string, PreservedOrderGuard> {
  const guards = new Map<string, PreservedOrderGuard>();
  for (const order of live) {
    if (
      order.type !== "LIMIT" ||
      order.price == null ||
      !Number.isSafeInteger(order.price) ||
      order.price <= 0 ||
      remainingQty(order) === 0
    ) {
      continue;
    }
    guards.set(order.id, { id: order.id, side: order.side, price: order.price, qty: remainingQty(order) });
  }
  return guards;
}

/**
 * A fully untouched dedicated-reserve row is not forensic state: it is an
 * obsolete duplicate left by an older ladder shape. Keep it as a temporary
 * self-trade boundary while the new wall is posted, then retire it only after
 * that complete wall is sufficient. PARTIAL rows deliberately never enter
 * this set.
 */
function retirableOpenReserveRows(live: LiveOrder[]): Map<string, RetirableQuote> {
  const rows = new Map<string, RetirableQuote>();
  for (const order of live) {
    if (
      order.type !== "LIMIT" ||
      order.price == null ||
      order.status !== "OPEN" ||
      order.filledQty !== 0 ||
      remainingQty(order) === 0
    ) {
      continue;
    }
    rows.set(order.id, { id: order.id, side: order.side, price: order.price, qty: remainingQty(order) });
  }
  return rows;
}

/**
 * Choose the nearest center whose complete ladder is strictly outside every
 * preserved opposite-side reserve order. Same-side duplicate prices are safe:
 * they aggregate into one visible level and let a historical partial remain a
 * natural support/resistance order instead of freezing the entire market.
 * `null` means the preserved orders themselves are crossed, so no safe
 * two-sided ladder can be added without mutating history.
 */
export function guardedQuoteCenter(
  def: SymbolDef,
  requestedCenter: number,
  guards: Iterable<Pick<LiquidityQuote, "side" | "price">>,
): number | null {
  const guardList = [...guards];
  let minimumCenter = def.tickSize;
  let maximumCenter = Number.MAX_SAFE_INTEGER;

  for (const guard of guardList) {
    const guardPrice = alignToTick(guard.price, def.tickSize);
    if (guard.side === "BUY") minimumCenter = Math.max(minimumCenter, guardPrice);
    else maximumCenter = Math.min(maximumCenter, guardPrice);
  }
  if (minimumCenter > maximumCenter) return null;

  const requested = alignToTick(requestedCenter, def.tickSize);
  const clamped = alignToTick(Math.min(Math.max(requested, minimumCenter), maximumCenter), def.tickSize);
  const canUseCenter = (center: number): boolean => {
    const plan = buildLiquidityLadder(def, center);
    return plan.every((quote) => canAddWithoutSelfTrade(quote, guardList));
  };
  if (canUseCenter(clamped)) return clamped;

  // Each preserved guard forbids only a finite set of same-side ladder
  // offsets. Search just beyond those candidates, preferring the higher tick
  // on ties so a preserved SELL remains closest to the refreshed wall.
  const searchSteps = guardList.length * LIQUIDITY_DISTANCE_TICKS.length + 1;
  for (let step = 1; step <= searchSteps; step++) {
    const up = clamped + step * def.tickSize;
    if (up <= maximumCenter && Number.isSafeInteger(up) && canUseCenter(up)) return up;
    const down = clamped - step * def.tickSize;
    if (down >= minimumCenter && Number.isSafeInteger(down) && canUseCenter(down)) return down;
  }
  return null;
}

/** Keep the one-tick recenter invariant when an intermediate price is guarded. */
export function moveGuardedQuoteCenter(
  def: SymbolDef,
  currentCenter: number,
  targetCenter: number,
  guards: Iterable<Pick<LiquidityQuote, "side" | "price">>,
): number {
  const guardList = [...guards];
  const next = moveQuoteCenter(currentCenter, targetCenter, def.tickSize);
  return guardedQuoteCenter(def, next, guardList) === next ? next : currentCenter;
}

/**
 * A clean dedicated reserve normally already owns the complete ladder after
 * a bots restart.  Accept a compatible, intact older 8-level subset too, so
 * expanding the reserve never starts with a cancel-all gap: the normal fast
 * reconciliation adds only the newly required outer levels.
 */
export function adoptExistingLadder(
  live: LiveOrder[],
  def: SymbolDef,
  fallbackCenter: number,
): {
  center: number;
  active: Map<string, ManagedQuote>;
  preserved: Map<string, PreservedOrderGuard>;
  retirable: Map<string, RetirableQuote>;
} | null {
  const candidates = new Set<number>([alignToTick(fallbackCenter, def.tickSize)]);
  for (const order of live) {
    if (order.type !== "LIMIT" || order.price == null) continue;
    for (const distance of LIQUIDITY_DISTANCE_TICKS) {
      const offset = distance * def.tickSize;
      candidates.add(alignToTick(order.side === "BUY" ? order.price + offset : order.price - offset, def.tickSize));
    }
  }

  for (const center of candidates) {
    const plan = buildLiquidityLadder(def, center);
    const remaining = [...live];
    const active = new Map<string, ManagedQuote>();
    const adoptedBySide = new Map<"BUY" | "SELL", number>([
      ["BUY", 0],
      ["SELL", 0],
    ]);
    for (const quote of plan) {
      const matchingOrder = (order: LiveOrder) =>
        order.type === "LIMIT" &&
        order.side === quote.side &&
        order.price === quote.price &&
        order.status === "OPEN" &&
        order.filledQty === 0 &&
        remainingQty(order) > 0;
      // A previous version used the then-current share quantity as part of
      // this identity match. A price-normalised ladder can legitimately make
      // an inherited SAKU 160-share rung larger than its new target, so use
      // side+price first. This preserves an intact wall through restart and
      // lets normal low-water replenishment converge it without a cancel-all
      // startup gap. Prefer an exact size when a duplicate PARTIAL exists.
      let index = remaining.findIndex(
        (order) => matchingOrder(order) && remainingQty(order) === quote.qty,
      );
      if (index < 0) {
      // Dynamic quantities mean neither OPEN row may exactly equal the new
      // target. PARTIAL rows are excluded above and stay behind as permanent
      // identity guards; among untouched OPEN duplicates prefer the larger
      // row for the active rung.
        for (let candidate = 0; candidate < remaining.length; candidate++) {
          if (!matchingOrder(remaining[candidate])) continue;
          if (
            index < 0 ||
            remainingQty(remaining[candidate]) > remainingQty(remaining[index]) ||
            (remainingQty(remaining[candidate]) === remainingQty(remaining[index]) &&
              remaining[candidate].status === "OPEN" &&
              remaining[index].status !== "OPEN")
          ) {
            index = candidate;
          }
        }
      }
      if (index < 0) continue;
      const [order] = remaining.splice(index, 1);
      const actualQty = remainingQty(order);
      active.set(quoteKey(quote), {
        ...quote,
        qty: actualQty,
        id: order.id,
        // A fixed-share legacy ladder may be vastly oversized at a costly
        // symbol. It is adopted first to avoid a restart gap, then each row
        // is safely post-before-cancel normalised on the regular refresh.
        needsNormalization: actualQty > quote.qty || undefined,
      });
      adoptedBySide.set(quote.side, (adoptedBySide.get(quote.side) ?? 0) + 1);
    }
    if (
      (adoptedBySide.get("BUY") ?? 0) < MIN_ADOPTABLE_LEVELS_PER_SIDE ||
      (adoptedBySide.get("SELL") ?? 0) < MIN_ADOPTABLE_LEVELS_PER_SIDE
    ) {
      continue;
    }

    // A full compatible ladder can coexist with a few leftover reserve rows
    // from an interrupted refresh. Only untouched OPEN duplicates are safe to
    // retire later; a PARTIAL row remains a permanent identity guard. Validate
    // every residual against the full *new* plan, not merely its adopted
    // subset, so a missing rung can never create a deferred self-cross.
    const executableRemaining = remaining.filter((order) => remainingQty(order) > 0);
    const retirableRows = retirableOpenReserveRows(executableRemaining);
    const permanentRows = executableRemaining.filter((order) => !retirableRows.has(order.id));
    const preserved = unretirableReserveGuards(permanentRows);
    if (preserved.size !== permanentRows.length || retirableRows.size + preserved.size !== executableRemaining.length) {
      continue;
    }
    const guardBoundary: Array<Pick<LiquidityQuote, "side" | "price">> = [...plan];
    let residualsAreSafe = true;
    for (const guard of [...preserved.values(), ...retirableRows.values()]) {
      if (!canAddWithoutSelfTrade(guard, guardBoundary)) {
        residualsAreSafe = false;
        break;
      }
      guardBoundary.push(guard);
    }
    if (residualsAreSafe) return { center, active, preserved, retirable: retirableRows };
  }
  return null;
}

/**
 * Keep cancellation-pending orders in `retiring` until the account API has
 * observed them as terminal.  Dropping them when DELETE returns would leave a
 * window in which a new opposite quote can self-match in the matching stream.
 */
async function reconcileQuotes(
  client: ApiClient,
  symbol: string,
  active: Map<string, ManagedQuote>,
  retiring: Map<string, ManagedQuote>,
  preserved: Map<string, PreservedOrderGuard>,
  retirable: Map<string, RetirableQuote>,
  budgetedPreserved: Map<string, PreservedOrderGuard>,
): Promise<void> {
  const orders = await client.myLiveOrders(symbol);
  const liveById = new Map(orders.map((order) => [order.id, order]));
  // A per-symbol live list normally contains this maker's 24 quotes.  If it
  // reaches the API cap, retain unknown IDs rather than allowing an old
  // opposite quote to self-match.
  const mayBeTruncated = orders.length >= 200;
  const isStillLive = (id: string): boolean => liveById.has(id) || mayBeTruncated;

  for (const [key, quote] of active) {
    const live = liveById.get(quote.id);
    if (!live && !mayBeTruncated) {
      active.delete(key);
      continue;
    }
    // A partial fill remains OPEN/PARTIAL, so an ID-only reconciliation used
    // to mistake depleted size for a full wall.  Keep the actual remaining
    // size in `active`; the next full-ladder pass posts a fresh quote first
    // and then retires this partial remainder without creating a gap.
    if (live) {
      const remaining = remainingQty(live);
      if (remaining !== quote.qty) active.set(key, { ...quote, qty: remaining });
    }
  }
  for (const [id, quote] of retiring) {
    const live = liveById.get(quote.id);
    if (!live && !mayBeTruncated) {
      retiring.delete(id);
      continue;
    }
    if (live) {
      const qty = remainingQty(live);
      if (qty !== quote.qty) retiring.set(id, { ...quote, qty });
    }
  }
  // Preserved rows are intentionally never cancelled by this maker. Their
  // remaining size can still change as takers execute against them, so update
  // the depth budget on every observed fill. Once terminal, drop only the
  // guard so later recentering can use the freed price range.
  for (const [id, guard] of preserved) {
    const live = liveById.get(id);
    if (!live && !mayBeTruncated) {
      preserved.delete(id);
      continue;
    }
    if (live) {
      const qty = remainingQty(live);
      if (qty !== guard.qty) preserved.set(id, { ...guard, qty });
    }
  }
  clampBudgetedPreservedGuards(preserved, budgetedPreserved);
  for (const [id, quote] of retirable) {
    const live = liveById.get(id);
    if (!live && !mayBeTruncated) {
      retirable.delete(id);
      continue;
    }
    if (live) {
      const qty = remainingQty(live);
      if (qty !== quote.qty) retirable.set(id, { ...quote, qty });
    }
  }
}

function matchesPlan(active: Map<string, ManagedQuote>, plan: LiquidityQuote[]): boolean {
  return (
    active.size === plan.length &&
    plan.every((quote) => {
      const current = active.get(quoteKey(quote));
      return isQuoteSufficient(current, quote);
    })
  );
}

/**
 * Safely replace one quote.  The replacement is posted first so there is no
 * empty-book gap, but only after strict comparison with both active and
 * cancellation-pending opposite-side quotes.  Equality is forbidden too.
 */
async function replaceQuote(
  client: ApiClient,
  symbol: string,
  desired: LiquidityQuote,
  active: Map<string, ManagedQuote>,
  retiring: Map<string, ManagedQuote>,
  preserved: Map<string, PreservedOrderGuard>,
  retirable: Map<string, RetirableQuote>,
): Promise<void> {
  const key = quoteKey(desired);
  const current = active.get(key);
  if (isQuoteSufficient(current, desired)) return;

  if (!canAddWithoutSelfTrade(desired, trackedQuotes(active, retiring, preserved.values(), retirable.values()))) return;

  let placed: { id: string };
  try {
    placed = await client.placeOrder({
      symbol,
      side: desired.side,
      type: "LIMIT",
      price: desired.price,
      qty: desired.qty,
    });
  } catch (error) {
    if (isRejection(error)) return;
    throw error;
  }

  active.set(key, { ...desired, id: placed.id });
  if (!current) return;

  // The old quote remains in the guard until reconcileQuotes sees a terminal
  // status, even if the cancellation request itself returned successfully.
  retiring.set(current.id, current);
  try {
    await client.cancelOrder(current.id);
  } catch (error) {
    if (!isRejection(error)) throw error;
  }
}

async function refreshLevel(
  client: ApiClient,
  symbol: string,
  plan: LiquidityQuote[],
  level: number,
  active: Map<string, ManagedQuote>,
  retiring: Map<string, ManagedQuote>,
  preserved: Map<string, PreservedOrderGuard>,
  retirable: Map<string, RetirableQuote>,
  centerDirection: number,
  continueOnError = false,
): Promise<void> {
  const quotes = plan.filter((quote) => quote.level === level);
  // When moving up, clear/repost asks first; when moving down, do bids first.
  // The price guard is still authoritative, so this only improves recovery
  // speed and does not rely on asynchronous stream ordering for correctness.
  const firstSide = centerDirection > 0 ? "SELL" : "BUY";
  quotes.sort((a, b) => Number(a.side !== firstSide) - Number(b.side !== firstSide));

  for (const quote of quotes) {
    try {
      await replaceQuote(client, symbol, quote, active, retiring, preserved, retirable);
    } catch (error) {
      if (!continueOnError) throw error;
      // Placement is deliberately per-quote fault tolerant. A single
      // transient POST/DELETE failure must not leave a successfully posted
      // side thin while unrelated levels wait for another loop.
      console.warn(
        `[mm:${symbol}] ${quote.side} level ${level} deferred`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}

/**
 * Reconcile every level after a fill rather than waiting for a rotating depth
 * cursor.  Calls for already aligned quotes are in-memory no-ops, so this
 * creates network traffic only for missing, partial, or recentered levels.
 */
async function refreshWholeLadder(
  client: ApiClient,
  symbol: string,
  plan: LiquidityQuote[],
  active: Map<string, ManagedQuote>,
  retiring: Map<string, ManagedQuote>,
  preserved: Map<string, PreservedOrderGuard>,
  centerDirection: number,
  continueOnError = false,
  retirable: Map<string, RetirableQuote> = new Map(),
): Promise<void> {
  for (let level = 0; level < LIQUIDITY_DISTANCE_TICKS.length; level++) {
    await refreshLevel(
      client,
      symbol,
      plan,
      level,
      active,
      retiring,
      preserved,
      retirable,
      centerDirection,
      continueOnError,
    );
  }
}

/**
 * Retire the old edge only after a complete replacement plan is executable.
 * This is the inverse of the old cancel-all startup behaviour: every visible
 * side remains full while the matching engine processes the two edge swaps.
 */
async function retireRetirableQuotes(
  client: Pick<ApiClient, "cancelOrder">,
  retirable: Map<string, RetirableQuote>,
  retiring: Map<string, ManagedQuote>,
): Promise<void> {
  for (const [id, quote] of [...retirable]) {
    // Preserve the known remaining size until the API confirms terminal so a
    // concurrent snapshot can subtract this own cancellation-pending depth.
    retiring.set(id, { ...quote, level: -1 });
    retirable.delete(id);
    try {
      await client.cancelOrder(id);
    } catch (error) {
      if (!isRejection(error)) throw error;
    }
  }
}

/**
 * Full OPEN leftovers may be retired only after the active normalised ladder
 * is complete. This small boundary is kept separate from PARTIAL guards so
 * restart cleanup can be tested without an unsafe cancel-all phase.
 */
export async function retireRetirableQuotesWhenPlanIsSufficient(
  client: Pick<ApiClient, "cancelOrder">,
  active: Map<string, ManagedQuote>,
  plan: LiquidityQuote[],
  retirable: Map<string, RetirableQuote>,
  retiring: Map<string, ManagedQuote>,
): Promise<boolean> {
  if (!matchesPlan(active, plan)) return false;
  await retireRetirableQuotes(client, retirable, retiring);
  return true;
}

/**
 * Reserve-only startup path for inherited rows that cannot be discarded
 * before a replacement exists. PARTIAL rows remain durable self-trade guards;
 * untouched OPEN rows are temporary boundaries retired only after a fresh
 * normalised ladder is complete.
 */
export async function initializeWithPreservedReserveGuards(
  client: ApiClient,
  def: SymbolDef,
  requestedCenter: number,
  live: LiveOrder[],
  active: Map<string, ManagedQuote>,
  retiring: Map<string, ManagedQuote>,
  preserved: Map<string, PreservedOrderGuard>,
  retirable: Map<string, RetirableQuote> = new Map(),
  budgetedPreserved: ReadonlyMap<string, PreservedOrderGuard> = new Map(),
): Promise<{ center: number; count: number } | null> {
  const retirableRows = retirableOpenReserveRows(live);
  const permanentRows = live.filter((order) => !retirableRows.has(order.id));
  const guards = unretirableReserveGuards(permanentRows);
  if (guards.size === 0 && retirableRows.size === 0) return null;
  const allBoundaries = [...guards.values(), ...retirableRows.values()];
  const center = guardedQuoteCenter(def, requestedCenter, allBoundaries);
  if (center == null) {
    throw new MarketMakerStartupBlockedError(
      `[mm:${def.symbol}] preserved reserve rows are already crossed; cannot add a safe ladder`,
    );
  }

  for (const [id, guard] of guards) preserved.set(id, guard);
  for (const [id, quote] of retirableRows) retirable.set(id, quote);
  await refreshWholeLadder(
    client,
    def.symbol,
    // A fresh startup has not yet verified snapshot-visible PARTIAL depth.
    // Start full; the later snapshot pass can only shrink via post-before-
    // cancel normalisation.
    buildMarketMakerPlan(def, center, budgetedPreserved),
    active,
    retiring,
    preserved,
    0,
    true,
    retirable,
  );
  return { center, count: guards.size };
}

/**
 * Maintains a deep two-sided wall without the cancel-all gap of the old
 * strategy. Price-normalised best walls absorb ordinary flow while larger
 * orders walk orderly, tick-spaced depth instead of discontinuous gaps.
 */
export async function runMarketMaker(
  client: ApiClient,
  def: SymbolDef,
  ref: MarketModel,
  options: MarketMakerOptions = {},
): Promise<void> {
  const active = new Map<string, ManagedQuote>();
  const retiring = new Map<string, ManagedQuote>();
  const preserved = new Map<string, PreservedOrderGuard>();
  const budgetedPreserved = new Map<string, PreservedOrderGuard>();
  const retirable = new Map<string, RetirableQuote>();
  let initialized = false;
  let quoteCenter = alignToTick(ref.get(def.symbol), def.tickSize);
  let lastReconcileAt = 0;
  let lastPreservedDepthRefreshAt = 0;

  while (true) {
    try {
      if (!initialized) {
        const inherited = await client.myLiveOrders(def.symbol);
        const adopted = adoptExistingLadder(inherited, def, quoteCenter);
        if (adopted) {
          quoteCenter = adopted.center;
          const adoptedRetirableCount = adopted.retirable.size;
          for (const [key, quote] of adopted.active) active.set(key, quote);
          for (const [id, guard] of adopted.preserved) preserved.set(id, guard);
          if (options.allowUnretirableReserveFallback) {
            for (const [id, quote] of adopted.retirable) retirable.set(id, quote);
          } else {
            // The generic/legacy maker path keeps its historical fail-closed
            // behaviour. Only the clean dedicated reserve may auto-retire an
            // untouched duplicate after it proves a complete replacement.
            for (const [id, quote] of adopted.retirable) preserved.set(id, quote);
          }
          const adoptedPlan = buildMarketMakerPlan(def, quoteCenter, budgetedPreserved);
          // The inherited rows were matched against the ordinary ladder so
          // they can be adopted without a restart gap. Once a PARTIAL is
          // known, mark only oversized fresh rows for post-before-cancel
          // normalisation against its reduced notional budget.
          for (const quote of remapActiveQuotesForPlan(active, adoptedPlan)) {
            retirable.set(quote.id, quote);
          }
          // An older 8-level reserve is a compatible subset of the current
          // 12-level plan. Post every missing/oversized normalised rung first;
          // untouched duplicate OPEN rows remain temporary self-trade guards
          // until this plan is complete.
          await refreshWholeLadder(
            client,
            def.symbol,
            adoptedPlan,
            active,
            retiring,
            preserved,
            0,
            true,
            retirable,
          );
          if (options.allowUnretirableReserveFallback && retirable.size > 0) {
            await retireRetirableQuotesWhenPlanIsSufficient(
              client,
              active,
              adoptedPlan,
              retirable,
              retiring,
            );
          }
          initialized = true;
          lastReconcileAt = Date.now();
          console.log(
            `[mm:${def.symbol}] adopted ${active.size} inherited reserve quotes` +
              (preserved.size ? ` with ${preserved.size} PARTIAL reserve guard(s)` : "") +
              (adoptedRetirableCount
                ? `; retired ${adoptedRetirableCount} untouched OPEN duplicate row(s) after normalisation`
                : ""),
          );
          continue;
        }

        // Any inherited dedicated-reserve row, including an untouched OPEN
        // duplicate, gets a new complete ladder first. This avoids falling
        // through to the legacy cancel-all path merely because an interrupted
        // refresh left fewer than eight compatible rungs per side.
        if (options.allowUnretirableReserveFallback && inherited.length > 0) {
          const preservedStartup = await initializeWithPreservedReserveGuards(
            client,
            def,
            quoteCenter,
            inherited,
            active,
            retiring,
            preserved,
            retirable,
            budgetedPreserved,
          );
          if (preservedStartup) {
            quoteCenter = preservedStartup.center;
            if (retirable.size > 0) {
              await retireRetirableQuotesWhenPlanIsSufficient(
                client,
                active,
                buildMarketMakerPlan(def, quoteCenter, budgetedPreserved),
                retirable,
                retiring,
              );
            }
            initialized = true;
            lastReconcileAt = Date.now();
            console.warn(
              `[mm:${def.symbol}] preserved ${preservedStartup.count} partial reserve order(s) as self-trade guards`,
            );
            continue;
          }
        }

        try {
          await retirePreviousQuotes(client, def.symbol, inherited);
        } catch (error) {
          if (!options.allowUnretirableReserveFallback || !(error instanceof MarketMakerStartupBlockedError)) {
            throw error;
          }

          // A bad historical settlement row can leave a dedicated reserve
          // LIMIT order PARTIAL forever even after DELETE succeeds.  Do not
          // repair or cancel that durable row again: preserve it solely as a
          // guard, choose a center outside it, and make a fresh reserve wall.
          const unretirable = await client.myLiveOrders(def.symbol);
          const preservedStartup = await initializeWithPreservedReserveGuards(
            client,
            def,
            quoteCenter,
            unretirable,
            active,
            retiring,
            preserved,
            retirable,
            budgetedPreserved,
          );
          if (!preservedStartup) throw error;
          quoteCenter = preservedStartup.center;
          if (retirable.size > 0) {
            await retireRetirableQuotesWhenPlanIsSufficient(
              client,
              active,
              buildMarketMakerPlan(def, quoteCenter, budgetedPreserved),
              retirable,
              retiring,
            );
          }
          initialized = true;
          lastReconcileAt = Date.now();
          console.warn(
            `[mm:${def.symbol}] preserved ${preservedStartup.count} unretirable reserve order(s) as self-trade guards`,
          );
          continue;
        }
        const initialPlan = buildMarketMakerPlan(def, quoteCenter, budgetedPreserved);
        await refreshWholeLadder(client, def.symbol, initialPlan, active, retiring, preserved, 0, true);
        // Reconcile/replenish any individually deferred level on the normal
        // loop. Crucially, do not re-enter retirePreviousQuotes and create a
        // cancel-all gap merely because one startup request failed.
        initialized = true;
        continue;
      }

      const now = Date.now();
      if (now - lastReconcileAt >= QUOTE_RECONCILE_MS) {
        await reconcileQuotes(client, def.symbol, active, retiring, preserved, retirable, budgetedPreserved);
        lastReconcileAt = now;
      }

      if (now - lastPreservedDepthRefreshAt >= PRESERVED_DEPTH_REFRESH_MS) {
        await refreshBudgetedPreservedGuards(
          client,
          def.symbol,
          active,
          retiring,
          preserved,
          retirable,
          budgetedPreserved,
        );
        lastPreservedDepthRefreshAt = now;
      }

      const currentPlan = buildMarketMakerPlan(def, quoteCenter, budgetedPreserved);
      // A durable partial can be filled between passes. Re-map even when the
      // center is unchanged so an old fresh wall that is now too large is
      // safely normalised rather than permanently stacking with the guard.
      for (const quote of remapActiveQuotesForPlan(active, currentPlan)) {
        retirable.set(quote.id, quote);
      }
      const requestedCenter = alignToTick(ref.get(def.symbol), def.tickSize);
      // Preserve an unretirable reserve order as an always-on opposite-side
      // guard.  Clamp drift before a new quote is attempted, rather than
      // relying on an individual level to be rejected after the center moves.
      const targetCenter = guardedQuoteCenter(def, requestedCenter, preserved.values()) ?? quoteCenter;
      const previousCenter = quoteCenter;
      // A conventional level-keyed refresh would cancel and recreate all 24
      // quotes for a one-tick move, flooding the single-writer stream and
      // leaving the displayed price stuck. A candidate must instead coexist
      // with every active, cancellation-pending, preserved and retirable row.
      // The consecutive ladder then reuses its eleven interior prices/side.
      if (retirable.size === 0 && matchesPlan(active, currentPlan)) {
        const candidateCenter = moveGuardedQuoteCenter(def, quoteCenter, targetCenter, preserved.values());
        const candidatePlan = buildMarketMakerPlan(def, candidateCenter, budgetedPreserved);
        if (
          candidateCenter === quoteCenter ||
          canPlanCoexist(candidatePlan, active, retiring, preserved.values(), retirable.values())
        ) {
          quoteCenter = candidateCenter;
        }
      }

      const centerDirection = Math.sign(quoteCenter - previousCenter);
      const desiredPlan = buildMarketMakerPlan(def, quoteCenter, budgetedPreserved);
      if (quoteCenter !== previousCenter) {
        for (const quote of remapActiveQuotesForPlan(active, desiredPlan)) {
          retirable.set(quote.id, quote);
        }
      }
      await refreshWholeLadder(
        client,
        def.symbol,
        desiredPlan,
        active,
        retiring,
        preserved,
        centerDirection,
        true,
        retirable,
      );
      // New edge rows are posted first. Only after both sides again meet their
      // low-water quantity do we cancel the obsolete two edge rows.
      if (retirable.size > 0) {
        await retireRetirableQuotesWhenPlanIsSufficient(client, active, desiredPlan, retirable, retiring);
      }
    } catch (error) {
      // A stuck legacy account must not spin forever and prevent a clean
      // provider from taking over this symbol. Normal transport failures still
      // retry on the same provider.
      if (!initialized && error instanceof MarketMakerStartupBlockedError) throw error;
      console.error(`[mm:${def.symbol}]`, error instanceof Error ? error.message : error);
    }
    await sleep(80 + Math.random() * 50);
  }
}
