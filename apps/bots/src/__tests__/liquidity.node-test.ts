import assert from "node:assert/strict";
import test from "node:test";
import type { SymbolDef } from "@mock-kabu/shared";
import type { LiveOrder } from "../client";
import {
  buildGuardAwareLiquidityLadder,
  buildLiquidityLadder,
  canAddWithoutSelfTrade,
  canLaddersCoexist,
  GUARD_AWARE_VISIBLE_TARGET_CAP_MULTIPLIER,
  LIQUIDITY_MIN_BEST_QTY,
  liquidityBestWallQty,
  liquidityQtyByLevel,
  liquidityTotalQty,
  moveQuoteCenter,
  VISIBLE_LIQUIDITY_LEVELS,
  visibleLadderNotional,
} from "../liquidity";
import {
  adoptExistingLadder,
  budgetPreservedGuardsFromSnapshot,
  guardedQuoteCenter,
  initializeWithPreservedReserveGuards,
  isQuoteSufficient,
  moveGuardedQuoteCenter,
  remapActiveQuotesForPlan,
  type ManagedQuote,
  retireRetirableQuotesWhenPlanIsSufficient,
  type PreservedOrderGuard,
  unretirableReserveGuards,
} from "../market-maker";

const KABU: SymbolDef = {
  symbol: "KABU",
  name: "test",
  initialPrice: 120_000,
  tickSize: 100,
};

const TANU: SymbolDef = {
  symbol: "TANU",
  name: "test",
  initialPrice: 8_000,
  tickSize: 10,
};

const SAKU: SymbolDef = {
  symbol: "SAKU",
  name: "test",
  initialPrice: 300_000,
  tickSize: 500,
};

const PENNY: SymbolDef = {
  symbol: "PENNY",
  name: "test",
  initialPrice: 100,
  tickSize: 1,
};

const TEN_THOUSAND: SymbolDef = {
  symbol: "TENK",
  name: "test",
  initialPrice: 10_000,
  tickSize: 10,
};

function liveLadder(def: SymbolDef, center: number): LiveOrder[] {
  return buildLiquidityLadder(def, center).map((quote) => ({
    id: `rung-${quote.side}-${quote.level}`,
    symbol: def.symbol,
    side: quote.side,
    type: "LIMIT",
    price: quote.price,
    qty: quote.qty,
    filledQty: 0,
    status: "OPEN",
  }));
}

test("liquidity ladder has dense, substantial depth on both sides", () => {
  const quotes = buildLiquidityLadder(KABU, 120_000);
  const bids = quotes.filter((quote) => quote.side === "BUY");
  const asks = quotes.filter((quote) => quote.side === "SELL");

  assert.equal(bids.length, 12);
  assert.equal(asks.length, 12);
  assert.equal(bids[0].price, 119_900);
  assert.equal(asks[0].price, 120_100);
  assert.ok(bids[0].qty >= 80);
  assert.ok(asks[0].qty >= 80);
  assert.equal(bids[11].price, 118_800);
  assert.equal(asks[11].price, 121_200);
  assert.equal(bids.reduce((sum, quote) => sum + quote.qty, 0), liquidityTotalQty(120_000));
  assert.equal(asks.reduce((sum, quote) => sum + quote.qty, 0), liquidityTotalQty(120_000));
  assert.ok(Math.max(...bids.map((quote) => quote.price)) < Math.min(...asks.map((quote) => quote.price)));

  for (let index = 1; index < bids.length; index++) {
    assert.ok(bids[index - 1].price > bids[index].price);
    assert.ok(asks[index - 1].price < asks[index].price);
  }
});

test("price-normalised ladders keep comparable visible notional from ₩100 through ₩300,000", () => {
  const visibleNotional = (def: SymbolDef) => {
    const ladder = buildLiquidityLadder(def, def.initialPrice);
    const bids = ladder.filter((quote) => quote.side === "BUY").slice(0, 10);
    const asks = ladder.filter((quote) => quote.side === "SELL").slice(0, 10);
    return {
      bid: bids.reduce((sum, quote) => sum + quote.price * quote.qty, 0),
      ask: asks.reduce((sum, quote) => sum + quote.price * quote.qty, 0),
    };
  };

  const values = [PENNY, TEN_THOUSAND, SAKU].flatMap((def) => {
    const { bid, ask } = visibleNotional(def);
    return [bid, ask];
  });
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);

  // The two outer reserve rungs are deliberately outside the ten visible rows,
  // so a visible side carries a little under the ₩48m full-side target.
  assert.ok(minimum >= 40_000_000);
  assert.ok(maximum <= 50_000_000);
  assert.ok(maximum / minimum < 1.25);
  assert.equal(liquidityTotalQty(100), 480_000);
  assert.equal(liquidityTotalQty(10_000), 4_800);
  assert.equal(liquidityTotalQty(300_000), 160);
  assert.ok(liquidityBestWallQty(SAKU, 300_000) >= 80);
  assert.equal(liquidityQtyByLevel(100).reduce((sum, qty) => sum + qty, 0), 480_000);
});

test("a visible SAKU PARTIAL offsets only its fresh side while the opposite wall keeps the shared target", () => {
  const center = 304_000;
  const baseline = buildLiquidityLadder(SAKU, center);
  const defaultTarget = Math.max(
    visibleLadderNotional(baseline, "BUY"),
    visibleLadderNotional(baseline, "SELL"),
  );
  const partial = {
    side: "SELL" as const,
    price: center + SAKU.tickSize,
    // About one normal visible side, deliberately at the fresh best so its
    // own >=80 shares can supply the taker-wall guarantee.
    qty: Math.floor(defaultTarget / (center + SAKU.tickSize)),
  };
  assert.ok(partial.qty >= LIQUIDITY_MIN_BEST_QTY);

  const guarded = buildGuardAwareLiquidityLadder(SAKU, center, [partial]);
  const freshSellBest = guarded.quotes.find((quote) => quote.side === "SELL" && quote.level === 0)!;
  const freshBuyBest = guarded.quotes.find((quote) => quote.side === "BUY" && quote.level === 0)!;

  assert.equal(guarded.defaultVisibleTargetNotional, defaultTarget);
  assert.equal(guarded.targetVisibleNotional, defaultTarget);
  assert.equal(guarded.preservedVisibleNotional.SELL, partial.price * partial.qty);
  assert.equal(guarded.preservedVisibleNotional.BUY, 0);
  assert.equal(guarded.freshVisibleBudget.SELL, defaultTarget - partial.price * partial.qty);
  assert.equal(guarded.freshVisibleBudget.BUY, defaultTarget);
  // The preserved best has the 80-share taker wall, so the fresh duplicate is
  // allowed to be the one-share visible filler instead of doubling depth.
  assert.ok(freshSellBest.qty >= 1 && freshSellBest.qty < LIQUIDITY_MIN_BEST_QTY);
  assert.ok(freshBuyBest.qty >= LIQUIDITY_MIN_BEST_QTY);
  assert.ok(guarded.freshVisibleNotional.SELL < defaultTarget * 0.15);
  assert.ok(guarded.freshVisibleNotional.BUY >= defaultTarget * 0.97);
  assert.ok(guarded.freshVisibleNotional.BUY <= defaultTarget * 1.05);

  for (const side of ["BUY", "SELL"] as const) {
    const quotes = guarded.quotes.filter((quote) => quote.side === side);
    assert.equal(quotes.length, 12);
    assert.equal(quotes.slice(0, VISIBLE_LIQUIDITY_LEVELS).length, VISIBLE_LIQUIDITY_LEVELS);
    assert.ok(quotes.every((quote) => quote.qty >= 1));
  }
  assert.ok(
    Math.max(...guarded.quotes.filter((quote) => quote.side === "BUY").map((quote) => quote.price)) <
      Math.min(...guarded.quotes.filter((quote) => quote.side === "SELL").map((quote) => quote.price)),
  );
  assert.ok(guarded.quotes.every((quote) => canAddWithoutSelfTrade(quote, [partial])));

  // The established no-guard path is intentionally byte-for-byte the old
  // symmetric plan; dynamic budgeting starts only when a guard is present.
  assert.deepEqual(buildLiquidityLadder(SAKU, center, { preserved: [] }), baseline);
});

test("an enormous visible PARTIAL caps opposite fresh expansion without weakening an unguarded best wall", () => {
  const center = 304_000;
  const baseline = buildLiquidityLadder(SAKU, center);
  const defaultTarget = Math.max(
    visibleLadderNotional(baseline, "BUY"),
    visibleLadderNotional(baseline, "SELL"),
  );
  const hugePartial = {
    side: "SELL" as const,
    // Keep the actual fresh best unguarded: it must retain its 80-share wall.
    price: center + SAKU.tickSize * 2,
    qty: Math.ceil((defaultTarget * 3) / (center + SAKU.tickSize * 2)),
  };
  const guarded = buildGuardAwareLiquidityLadder(SAKU, center, [hugePartial]);
  const expectedCap = defaultTarget * GUARD_AWARE_VISIBLE_TARGET_CAP_MULTIPLIER;

  assert.ok(guarded.uncappedTargetVisibleNotional > expectedCap);
  assert.equal(guarded.targetVisibleNotional, expectedCap);
  assert.equal(guarded.freshVisibleBudget.SELL, 0);
  assert.equal(guarded.freshVisibleBudget.BUY, expectedCap);
  assert.ok(
    guarded.quotes.find((quote) => quote.side === "SELL" && quote.level === 0)!.qty >=
      LIQUIDITY_MIN_BEST_QTY,
  );
  assert.ok(guarded.quotes.every((quote) => quote.qty >= 1));
});

test("only matching-engine snapshot-visible PARTIAL depth offsets a fresh wall", () => {
  const absentRaw = new Map<string, PreservedOrderGuard>([
    ["kabu-absent-buy", { id: "kabu-absent-buy", side: "BUY", price: 115_900, qty: 132 }],
  ]);
  const absentBudget = budgetPreservedGuardsFromSnapshot(absentRaw.values(), { bids: [], asks: [] });

  // A stale DB PARTIAL remains a raw self-trade guard, but cannot make the
  // fresh bid wall thin when no matching-engine snapshot level contains it.
  assert.equal(budgetPreservedGuardsFromSnapshot(absentRaw.values(), null).size, 0);
  assert.equal(absentBudget.size, 0);
  assert.equal(absentRaw.get("kabu-absent-buy")?.qty, 132);

  const rawSells = new Map<string, PreservedOrderGuard>([
    ["sell-a", { id: "sell-a", side: "SELL", price: 116_000, qty: 60 }],
    ["sell-b", { id: "sell-b", side: "SELL", price: 116_000, qty: 39 }],
  ]);
  const snapshot = { bids: [], asks: [{ price: 116_000, qty: 52 }] };
  const visibleBudget = budgetPreservedGuardsFromSnapshot(rawSells.values(), snapshot);
  const afterKnownFresh = budgetPreservedGuardsFromSnapshot(rawSells.values(), snapshot, [
    { side: "SELL", price: 116_000, qty: 12 },
  ]);

  assert.equal(
    [...visibleBudget.values()].reduce((sum, guard) => sum + guard.qty, 0),
    52,
  );
  assert.equal(
    [...rawSells.values()].reduce((sum, guard) => sum + guard.qty, 0),
    99,
  );
  // Snapshot aggregate includes this maker's already-known fresh row. It is
  // subtracted before any historical guard receives a depth budget.
  assert.equal(
    [...afterKnownFresh.values()].reduce((sum, guard) => sum + guard.qty, 0),
    40,
  );
});

test("quote center recentering is capped at one tick", () => {
  assert.equal(moveQuoteCenter(120_000, 121_000, 100), 120_100);
  assert.equal(moveQuoteCenter(120_000, 119_000, 100), 119_900);
  assert.equal(moveQuoteCenter(120_000, 120_100, 100), 120_100);
});

test("a one-tick recenter normalizes a reused best wall when it becomes a smaller outer rung", () => {
  const currentPlan = buildLiquidityLadder(SAKU, 304_000);
  const active = new Map<string, ManagedQuote>(
    currentPlan.map((quote) => [
      `${quote.side}:${quote.level}`,
      { ...quote, id: `active-${quote.side}-${quote.level}` },
    ]),
  );
  const oldBestBid = active.get("BUY:0")!;
  const nextPlan = buildLiquidityLadder(SAKU, 304_500);
  const obsolete = remapActiveQuotesForPlan(active, nextPlan);
  const nextOuterBid = nextPlan.find((quote) => quote.side === "BUY" && quote.price === oldBestBid.price)!;
  const reused = active.get(`BUY:${nextOuterBid.level}`)!;

  assert.equal(obsolete.length, 2);
  assert.equal(nextOuterBid.level, 1);
  assert.equal(reused.id, oldBestBid.id);
  assert.ok(oldBestBid.qty > nextOuterBid.qty);
  assert.equal(reused.needsNormalization, true);
  assert.equal(isQuoteSufficient(reused, nextOuterBid), false);
});

test("only a one-tick ladder recenter may overlap existing maker quotes", () => {
  const current = buildLiquidityLadder(KABU, 120_000);
  const oneTickHigher = buildLiquidityLadder(KABU, 120_100);
  const twoTicksHigher = buildLiquidityLadder(KABU, 120_200);

  assert.equal(canLaddersCoexist(current, oneTickHigher), true);
  assert.equal(canLaddersCoexist(current, twoTicksHigher), false);
  const reusableRows = current.filter((quote) =>
    oneTickHigher.some((next) => next.side === quote.side && next.price === quote.price),
  );
  assert.equal(reusableRows.length, 22);

  const oldBestAsk = current.find((quote) => quote.side === "SELL" && quote.level === 0)!;
  assert.equal(canAddWithoutSelfTrade({ side: "BUY", price: 120_000 }, [oldBestAsk]), true);
  assert.equal(canAddWithoutSelfTrade({ side: "BUY", price: 120_100 }, [oldBestAsk]), false);
});

test("an unretirable reserve PARTIAL is deduplicated and guarded without self-crossing", () => {
  const stalePartial: LiveOrder = {
    id: "bot18-stale-sell",
    symbol: "TANU",
    side: "SELL",
    type: "LIMIT",
    price: 8_560,
    qty: 160,
    filledQty: 2,
    status: "PARTIAL",
  };
  const fullyFilledButStillListed: LiveOrder = {
    ...stalePartial,
    id: "already-empty",
    filledQty: 160,
  };
  const guards = unretirableReserveGuards([stalePartial, { ...stalePartial }, fullyFilledButStillListed]);

  // Repeated startup polls must retain one guard by order ID, not stack the
  // same opposite-side boundary twice.
  assert.equal(guards.size, 1);
  assert.equal(guards.get(stalePartial.id)?.qty, 158);
  const center = guardedQuoteCenter(TANU, 8_440, guards.values());
  assert.equal(center, 8_440);

  const freshPlan = buildLiquidityLadder(TANU, center!);
  assert.equal(freshPlan.length, 24);
  assert.ok(freshPlan.every((quote) => canAddWithoutSelfTrade(quote, guards.values())));
  // A same-side partial can share its price with the fresh wall. This is safe
  // and avoids making one historical guard freeze every nearby center.
  assert.equal(
    freshPlan.filter((quote) => [...guards.values()].some((guard) => guard.side === quote.side && guard.price === quote.price))
      .length,
    1,
  );
  assert.equal(moveGuardedQuoteCenter(TANU, 8_460, 8_560, guards.values()), 8_470);
});

test("same-side reserve guards remain visible support or resistance without freezing recentering", () => {
  const support = { side: "BUY" as const, price: 115_900 };
  const nextUp = buildLiquidityLadder(KABU, 116_100);
  assert.equal(guardedQuoteCenter(KABU, 116_100, [support]), 116_100);
  assert.equal(moveGuardedQuoteCenter(KABU, 116_000, 116_100, [support]), 116_100);
  assert.ok(nextUp.some((quote) => quote.side === support.side && quote.price === support.price));
  assert.ok(nextUp.every((quote) => canAddWithoutSelfTrade(quote, [support])));

  const resistance = { side: "SELL" as const, price: 8_480 };
  assert.equal(moveGuardedQuoteCenter(TANU, 8_460, 8_490, [resistance]), 8_470);
  assert.equal(moveGuardedQuoteCenter(TANU, 8_470, 8_490, [resistance]), 8_480);
  // At 8,490 the new best bid would equal the preserved sell, so only the
  // actual execution of that resistance can unlock the next tick.
  assert.equal(moveGuardedQuoteCenter(TANU, 8_480, 8_490, [resistance]), 8_480);
});

test("crossed preserved guards fail closed instead of posting a self-crossing ladder", () => {
  assert.equal(
    guardedQuoteCenter(TANU, 8_570, [
      { side: "BUY", price: 8_580 },
      { side: "SELL", price: 8_560 },
    ]),
    null,
  );
});

test("reserve fallback posts a complete new ladder before retiring an untouched OPEN duplicate", async () => {
  const stalePartial: LiveOrder = {
    id: "bot18-stale-sell",
    symbol: "TANU",
    side: "SELL",
    type: "LIMIT",
    price: 8_560,
    qty: 160,
    filledQty: 2,
    status: "PARTIAL",
  };
  const staleOpen: LiveOrder = {
    id: "bot18-old-open-buy",
    symbol: "TANU",
    side: "BUY",
    type: "LIMIT",
    price: 8_200,
    qty: 160,
    filledQty: 0,
    status: "OPEN",
  };
  const placed: Array<{ side: "BUY" | "SELL"; price?: number; qty: number }> = [];
  const canceled: string[] = [];
  const client = {
    placeOrder: async (order: { side: "BUY" | "SELL"; price?: number; qty: number }) => {
      placed.push(order);
      return { id: `fresh-${placed.length}` };
    },
    cancelOrder: async (id: string) => {
      canceled.push(id);
      return {};
    },
  };
  const active = new Map();
  const retiring = new Map<string, any>();
  const preserved = new Map<string, PreservedOrderGuard>();
  const retirable = new Map();

  const result = await initializeWithPreservedReserveGuards(
    client as any,
    TANU,
    8_440,
    [stalePartial, staleOpen],
    active,
    retiring,
    preserved,
    retirable,
  );

  assert.deepEqual(result, { center: 8_440, count: 1 });
  assert.equal(active.size, 24);
  assert.equal(placed.length, 24);
  assert.equal(canceled.length, 0);
  assert.equal(preserved.size, 1);
  assert.equal(retirable.size, 1);
  assert.ok(
    placed.every((quote) =>
      canAddWithoutSelfTrade({ side: quote.side, price: quote.price! }, preserved.values()),
    ),
  );
  assert.equal(
    placed.filter((quote) => quote.side === "SELL" && quote.price === stalePartial.price).length,
    1,
  );
  const retired = await retireRetirableQuotesWhenPlanIsSufficient(
    client as any,
    active,
    buildLiquidityLadder(TANU, result!.center),
    retirable,
    retiring,
  );
  assert.equal(retired, true);
  assert.deepEqual(canceled, [staleOpen.id]);
  assert.equal(retiring.has(stalePartial.id), false);
});

test("adopts a complete reserve ladder and retains one safe residual by identity", () => {
  const kabuRows = liveLadder(KABU, 116_000);
  const kabuPartial: LiveOrder = {
    id: "bot17-extra-partial-buy",
    symbol: "KABU",
    side: "BUY",
    type: "LIMIT",
    price: 115_900,
    qty: 160,
    filledQty: 2,
    status: "PARTIAL",
  };
  // The API is newest-first, so the residual may precede the full rung.
  const kabu = adoptExistingLadder([kabuPartial, ...kabuRows], KABU, 116_000);
  assert.ok(kabu);
  assert.equal(kabu!.active.size, 24);
  assert.equal(kabu!.preserved.size, 1);
  assert.equal(kabu!.retirable.size, 0);
  assert.equal(kabu!.preserved.get(kabuPartial.id)?.price, 115_900);
  assert.notEqual(kabu!.active.get("BUY:0")?.id, kabuPartial.id);

  const sakuRows = liveLadder(SAKU, 304_000);
  const sakuExtra: LiveOrder = {
    id: "bot19-extra-safe-sell",
    symbol: "SAKU",
    side: "SELL",
    type: "LIMIT",
    price: 315_500,
    qty: 30,
    filledQty: 0,
    status: "OPEN",
  };
  const saku = adoptExistingLadder([sakuExtra, ...sakuRows], SAKU, 304_000);
  assert.ok(saku);
  assert.equal(saku!.active.size, 24);
  assert.equal(saku!.preserved.size, 0);
  assert.equal(saku!.retirable.get(sakuExtra.id)?.price, 315_500);
});

test("adopts price-compatible legacy rungs even when old fixed share quantities are larger", () => {
  const legacyRows = liveLadder(SAKU, 304_000).map((order) => ({ ...order, qty: 160 }));
  const duplicatePartial: LiveOrder = {
    ...legacyRows.find((order) => order.side === "BUY" && order.price === 303_500)!,
    id: "legacy-partial-before-full",
    filledQty: 2,
    status: "PARTIAL",
  };
  const adopted = adoptExistingLadder([duplicatePartial, ...legacyRows], SAKU, 304_000);

  assert.ok(adopted);
  assert.equal(adopted!.active.size, 24);
  assert.equal(adopted!.active.get("SELL:0")?.qty, 160);
  assert.equal(adopted!.active.get("BUY:11")?.qty, 160);
  assert.equal(adopted!.active.get("SELL:0")?.needsNormalization, true);
  assert.equal(adopted!.active.get("BUY:11")?.needsNormalization, true);
  assert.notEqual(adopted!.active.get("BUY:0")?.id, duplicatePartial.id);
  assert.equal(adopted!.preserved.get(duplicatePartial.id)?.price, duplicatePartial.price);
});

test("never adopts an inherited PARTIAL rung into the refill-and-cancel active set", () => {
  const rows = liveLadder(KABU, 116_000);
  const original = rows.find((order) => order.side === "BUY" && order.price === 115_900)!;
  const inheritedPartial: LiveOrder = {
    ...original,
    id: "bot17-partial-only-at-rung",
    filledQty: 2,
    status: "PARTIAL",
  };
  const adopted = adoptExistingLadder(
    [inheritedPartial, ...rows.filter((order) => order.id !== original.id)],
    KABU,
    116_000,
  );

  assert.ok(adopted);
  assert.equal(adopted!.active.has("BUY:0"), false);
  assert.equal(adopted!.preserved.get(inheritedPartial.id)?.price, inheritedPartial.price);
  assert.equal(adopted!.retirable.has(inheritedPartial.id), false);
});

test("keeps full OPEN duplicates until the normalized ladder is complete, then retires only those rows", async () => {
  const center = 304_000;
  const legacyRows = liveLadder(SAKU, center).map((order) => ({ ...order, qty: 160 }));
  const untouchedOpen: LiveOrder = {
    id: "bot19-old-open-sell",
    symbol: SAKU.symbol,
    side: "SELL",
    type: "LIMIT",
    price: 312_000,
    qty: 160,
    filledQty: 0,
    status: "OPEN",
  };
  const partialGuard: LiveOrder = {
    id: "bot19-old-partial-buy",
    symbol: SAKU.symbol,
    side: "BUY",
    type: "LIMIT",
    price: 296_000,
    qty: 160,
    filledQty: 2,
    status: "PARTIAL",
  };
  const adopted = adoptExistingLadder([untouchedOpen, partialGuard, ...legacyRows], SAKU, center);
  assert.ok(adopted);
  assert.equal(adopted!.active.size, 24);
  assert.equal(adopted!.retirable.size, 1);
  assert.equal(adopted!.preserved.size, 1);
  assert.equal(adopted!.preserved.get(partialGuard.id)?.price, partialGuard.price);

  const canceled: string[] = [];
  const retiring = new Map<string, any>();
  const plan = buildLiquidityLadder(SAKU, center);
  const beforeNormalized = await retireRetirableQuotesWhenPlanIsSufficient(
    { cancelOrder: async (id: string) => {
      canceled.push(id);
      return {};
    } } as any,
    adopted!.active,
    plan,
    adopted!.retirable,
    retiring,
  );
  assert.equal(beforeNormalized, false);
  assert.equal(canceled.length, 0);
  assert.equal(adopted!.active.size, 24);

  // Model the post-before-cancel replacement pass: every normalised new rung
  // is now live while the untouched legacy OPEN row is still only a boundary.
  for (const quote of plan) {
    const key = `${quote.side}:${quote.level}`;
    const current = adopted!.active.get(key)!;
    adopted!.active.set(key, { ...current, qty: quote.qty, needsNormalization: undefined });
  }
  const afterNormalized = await retireRetirableQuotesWhenPlanIsSufficient(
    { cancelOrder: async (id: string) => {
      canceled.push(id);
      return {};
    } } as any,
    adopted!.active,
    plan,
    adopted!.retirable,
    retiring,
  );
  assert.equal(afterNormalized, true);
  assert.deepEqual(canceled, [untouchedOpen.id]);
  assert.equal(adopted!.active.size, 24);
  assert.equal(adopted!.retirable.size, 0);
  assert.equal(retiring.size, 1);
  assert.equal(retiring.has(partialGuard.id), false);
});
