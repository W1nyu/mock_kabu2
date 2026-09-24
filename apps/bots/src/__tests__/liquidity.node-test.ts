import assert from "node:assert/strict";
import test from "node:test";
import type { SymbolDef } from "@mock-kabu/shared";
import { ApiError, type LiveOrder } from "../client";
import {
  buildGuardAwareLiquidityLadder,
  buildLiquidityLadder,
  canAddWithoutSelfTrade,
  canLaddersCoexist,
  GUARD_AWARE_VISIBLE_TARGET_CAP_MULTIPLIER,
  LIQUIDITY_BEST_REFILL_LOW_WATER_RATIO,
  SAKU_MIN_BEST_QTY,
  liquidityBestWallQty,
  liquidityMinimumBestQty,
  liquidityQtyByLevel,
  liquidityQtyByLevelForSymbol,
  liquidityTotalQty,
  moveQuoteCenter,
  VISIBLE_LIQUIDITY_LEVELS,
  visibleLadderNotional,
} from "../liquidity";
import {
  advanceStagedQuoteMigration,
  adoptExistingLadder,
  beginStagedQuoteMigration,
  budgetPreservedGuardsFromSnapshot,
  guardedQuoteCenter,
  initializeWithPreservedReserveGuards,
  isQuoteSufficient,
  moveGuardedQuoteCenter,
  quoteCenterFromMarketPrice,
  remapActiveQuotesForPlan,
  retryStaleRetiringCancels,
  OneSidedQuoteWatchdog,
  sideMatchesPlan,
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
  assert.ok(bids[0].qty >= 160);
  assert.ok(asks[0].qty >= 160);
  assert.equal(bids[0].refillLowWaterRatio, LIQUIDITY_BEST_REFILL_LOW_WATER_RATIO);
  assert.equal(asks[0].refillLowWaterRatio, LIQUIDITY_BEST_REFILL_LOW_WATER_RATIO);
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

test("a partially consumed ordinary best wall is replaced before it falls below the taker-safe floor", () => {
  const bestAsk = buildLiquidityLadder(KABU, KABU.initialPrice).find(
    (quote) => quote.side === "SELL" && quote.level === 0,
  )!;
  const lowWater = Math.ceil(bestAsk.qty * (bestAsk.refillLowWaterRatio ?? 1));

  assert.equal(lowWater, Math.ceil(bestAsk.qty * LIQUIDITY_BEST_REFILL_LOW_WATER_RATIO));
  assert.equal(isQuoteSufficient({ ...bestAsk, id: "kabu-near-floor", qty: lowWater }, bestAsk), true);
  assert.equal(isQuoteSufficient({ ...bestAsk, id: "kabu-needs-refill", qty: lowWater - 1 }, bestAsk), false);
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
  // so a visible side carries a little under the ₩120m full-side target.
  assert.ok(minimum >= 100_000_000);
  assert.ok(maximum <= 125_000_000);
  assert.ok(maximum / minimum < 1.25);
  assert.equal(liquidityTotalQty(100), 1_200_000);
  assert.equal(liquidityTotalQty(10_000), 12_000);
  assert.equal(liquidityTotalQty(300_000), 400);
  assert.ok(liquidityBestWallQty(SAKU, 300_000) >= 180);
  assert.equal(liquidityQtyByLevel(100).reduce((sum, qty) => sum + qty, 0), 1_200_000);
});

test("SAKU keeps its existing side budget concentrated at the near-price wall", () => {
  const standard = liquidityQtyByLevel(300_000);
  const saku = liquidityQtyByLevelForSymbol(SAKU, 300_000);
  const ladder = buildLiquidityLadder(SAKU, 300_000);
  const bestBid = ladder.find((quote) => quote.side === "BUY" && quote.level === 0)!;
  const nextBid = ladder.find((quote) => quote.side === "BUY" && quote.level === 1)!;
  const thirdBid = ladder.find((quote) => quote.side === "BUY" && quote.level === 2)!;

  // The per-side budget stays at 400 shares, but the three nearest executable
  // rungs are materially thicker than the generic high-price distribution.
  assert.equal(saku.reduce((sum, qty) => sum + qty, 0), liquidityTotalQty(300_000));
  assert.equal(saku[0], SAKU_MIN_BEST_QTY);
  assert.equal(liquidityMinimumBestQty(SAKU), SAKU_MIN_BEST_QTY);
  assert.ok(saku[1] > standard[1]);
  assert.ok(saku[2] > standard[2]);
  assert.ok(bestBid.qty > nextBid.qty && nextBid.qty > thirdBid.qty);
  assert.equal(liquidityBestWallQty(SAKU, 300_000), SAKU_MIN_BEST_QTY);

  // A predecessor's smaller best wall is post-before-cancel normalised only
  // once it falls below the profile's refill threshold.
  const lowWater = Math.ceil(bestBid.qty * (bestBid.refillLowWaterRatio ?? 1));
  assert.equal(isQuoteSufficient({ ...bestBid, id: "legacy-saku-best", qty: lowWater - 1 }, bestBid), false);
  assert.equal(isQuoteSufficient({ ...bestBid, id: "fresh-saku-best", qty: lowWater }, bestBid), true);
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
    // own >=100 shares can supply the SAKU taker-wall guarantee.
    qty: Math.floor(defaultTarget / (center + SAKU.tickSize)),
  };
  assert.ok(partial.qty >= liquidityMinimumBestQty(SAKU));

  const guarded = buildGuardAwareLiquidityLadder(SAKU, center, [partial]);
  const freshSellBest = guarded.quotes.find((quote) => quote.side === "SELL" && quote.level === 0)!;
  const freshBuyBest = guarded.quotes.find((quote) => quote.side === "BUY" && quote.level === 0)!;

  assert.equal(guarded.defaultVisibleTargetNotional, defaultTarget);
  assert.equal(guarded.targetVisibleNotional, defaultTarget);
  assert.equal(guarded.preservedVisibleNotional.SELL, partial.price * partial.qty);
  assert.equal(guarded.preservedVisibleNotional.BUY, 0);
  assert.equal(guarded.freshVisibleBudget.SELL, defaultTarget - partial.price * partial.qty);
  assert.equal(guarded.freshVisibleBudget.BUY, defaultTarget);
  // The preserved best has the 100-share taker wall, so the fresh duplicate is
  // allowed to be the one-share visible filler instead of doubling depth.
  assert.ok(freshSellBest.qty >= 1 && freshSellBest.qty < liquidityMinimumBestQty(SAKU));
  assert.ok(freshBuyBest.qty >= liquidityMinimumBestQty(SAKU));
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
    // Keep the actual fresh best unguarded: it must retain its 100-share wall.
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
      liquidityMinimumBestQty(SAKU),
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

test("a large matched price can immediately override an old synthetic reference", () => {
  assert.equal(quoteCenterFromMarketPrice(KABU, 120_000, 132_000, false), 132_000);
  assert.equal(quoteCenterFromMarketPrice(KABU, 120_000, 120_500, false), 120_000);
  assert.equal(quoteCenterFromMarketPrice(KABU, 120_000, 120_600, false), 120_600);
  assert.equal(beginStagedQuoteMigration(KABU, 120_000, 120_500), null);
  assert.equal(beginStagedQuoteMigration(KABU, 120_000, 120_600)?.firstSide, "SELL");
  // An active hidden event moves its reference first; its own executions then
  // feed the durable re-anchor once the event has settled.
  assert.equal(quoteCenterFromMarketPrice(KABU, 132_000, 120_000, true), 132_000);
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

test("ordinary one-tick drift reuses most rows while preserved depth keeps exact budgeting", () => {
  const original = buildLiquidityLadder(KABU, 120_000);
  const next = buildLiquidityLadder(KABU, 120_100);
  const asActive = () =>
    new Map<string, ManagedQuote>(
      original.map((quote) => [`${quote.side}:${quote.level}`, { ...quote, id: `${quote.side}:${quote.level}` }]),
    );

  const ordinary = asActive();
  assert.equal(remapActiveQuotesForPlan(ordinary, next).length, 2);
  assert.ok([...ordinary.values()].filter((quote) => quote.needsNormalization).length <= 4);

  const guarded = asActive();
  remapActiveQuotesForPlan(guarded, next, new Set(["BUY"]));
  assert.ok(
    [...guarded.values()].filter((quote) => quote.side === "BUY" && quote.needsNormalization).length >
      [...ordinary.values()].filter((quote) => quote.side === "BUY" && quote.needsNormalization).length,
  );
  assert.equal(
    [...guarded.values()].filter((quote) => quote.side === "SELL" && quote.needsNormalization).length,
    [...ordinary.values()].filter((quote) => quote.side === "SELL" && quote.needsNormalization).length,
  );
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

test("a far repricing builds the safe leading side before moving the blocked side", async () => {
  const run = async (
    targetCenter: number,
    expectedFirstSide: "BUY" | "SELL",
    partial: PreservedOrderGuard,
  ) => {
    const oldCenter = 120_000;
    const oldPlan = buildLiquidityLadder(KABU, oldCenter);
    const targetPlan = buildLiquidityLadder(KABU, targetCenter);
    const active = new Map<string, ManagedQuote>();
    const live = new Map<string, { side: "BUY" | "SELL"; price: number; qty: number }>();
    for (const quote of oldPlan) {
      const id = `old-${quote.side}-${quote.level}`;
      active.set(`${quote.side}:${quote.level}`, { ...quote, id });
      live.set(id, { side: quote.side, price: quote.price, qty: quote.qty });
    }
    // This is a historical PARTIAL in the same direction as the new support
    // or resistance. It must remain a boundary, never a cancellation target.
    const preserved = new Map<string, PreservedOrderGuard>([[partial.id, partial]]);
    live.set(partial.id, partial);
    const retiring = new Map<string, ManagedQuote>();
    const retirable = new Map();
    const placed: Array<{ id: string; side: "BUY" | "SELL"; price: number; qty: number }> = [];
    const canceled: string[] = [];
    const client = {
      placeOrder: async (order: { side: "BUY" | "SELL"; price?: number; qty: number }) => {
        if (order.price == null) throw new Error("staged LIMIT order omitted its price");
        const price = order.price;
        assert.ok(
          canAddWithoutSelfTrade({ side: order.side, price }, live.values()),
          `staged ${order.side} at ${price} self-crossed the live book`,
        );
        const id = `new-${placed.length}`;
        const row = { id, side: order.side, price, qty: order.qty };
        placed.push(row);
        live.set(id, row);
        return { id };
      },
      cancelOrder: async (id: string) => {
        assert.ok(live.has(id), `cancelled non-live row ${id}`);
        canceled.push(id);
        live.delete(id);
        return {};
      },
    };

    const migration = beginStagedQuoteMigration(KABU, oldCenter, targetCenter);
    assert.ok(migration);
    assert.equal(migration!.firstSide, expectedFirstSide);

    const first = await advanceStagedQuoteMigration(
      client as any,
      KABU.symbol,
      targetPlan,
      migration!,
      active,
      retiring,
      preserved,
      retirable,
    );
    assert.equal(first, "STAGING_FIRST_SIDE");
    assert.equal(retiring.size, 12);
    assert.equal(canceled.length, 12);
    assert.ok(canceled.every((id) => id.startsWith(`old-${expectedFirstSide}-`)));
    assert.ok(sideMatchesPlan(active, targetPlan, expectedFirstSide));

    // The API reconciliation confirms those cancellations before the opposite
    // side moves. In production this is reconcileQuotes(), not a blind DELETE.
    retiring.clear();
    const second = await advanceStagedQuoteMigration(
      client as any,
      KABU.symbol,
      targetPlan,
      migration!,
      active,
      retiring,
      preserved,
      retirable,
    );
    assert.equal(second, "STAGING_SECOND_SIDE");
    assert.ok(sideMatchesPlan(active, targetPlan, "BUY"));
    assert.ok(sideMatchesPlan(active, targetPlan, "SELL"));
    assert.equal(canceled.includes(partial.id), false);
    assert.ok(canceled.slice(12).every((id) => !id.startsWith(`old-${expectedFirstSide}-`)));
    assert.equal(
      await advanceStagedQuoteMigration(
        client as any,
        KABU.symbol,
        targetPlan,
        migration!,
        active,
        retiring,
        preserved,
        retirable,
      ),
      "COMPLETE",
    );

    const liveRows = [...live.values()];
    assert.ok(liveRows.every((quote) => canAddWithoutSelfTrade(quote, liveRows)));
    assert.equal(
      liveRows.filter((quote) => quote.side === "BUY" && quote.price >= targetCenter - 1_200).length,
      12,
    );
    assert.equal(
      liveRows.filter((quote) => quote.side === "SELL" && quote.price <= targetCenter + 1_200).length,
      12,
    );
  };

  await run(132_000, "SELL", { id: "partial-support", side: "BUY", price: 118_000, qty: 30 });
  await run(108_000, "BUY", { id: "partial-resistance", side: "SELL", price: 122_000, qty: 30 });
});

test("a staged side starts every safe replacement before the first request resolves", async () => {
  const oldCenter = 120_000;
  const targetCenter = 121_200;
  const oldPlan = buildLiquidityLadder(KABU, oldCenter);
  const targetPlan = buildLiquidityLadder(KABU, targetCenter);
  const active = new Map<string, ManagedQuote>(
    oldPlan.map((quote) => [
      `${quote.side}:${quote.level}`,
      { ...quote, id: `old-${quote.side}-${quote.level}` },
    ]),
  );
  const retiring = new Map<string, ManagedQuote>();
  const preserved = new Map<string, PreservedOrderGuard>();
  const retirable = new Map();
  const migration = beginStagedQuoteMigration(KABU, oldCenter, targetCenter);
  assert.ok(migration);
  assert.equal(migration!.firstSide, "SELL");

  let started = 0;
  let releaseGate: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  let allStarted: () => void = () => {};
  const allRequestsStarted = new Promise<void>((resolve) => {
    allStarted = resolve;
  });
  const client = {
    placeOrder: async () => {
      const id = `new-${++started}`;
      if (started === 12) allStarted();
      await gate;
      return { id };
    },
    cancelOrder: async () => ({}),
  };

  const progress = advanceStagedQuoteMigration(
    client as any,
    KABU.symbol,
    targetPlan,
    migration!,
    active,
    retiring,
    preserved,
    retirable,
  );
  const concurrent = await Promise.race([
    allRequestsStarted.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
  ]);
  releaseGate();

  assert.equal(concurrent, true);
  assert.equal(await progress, "STAGING_FIRST_SIDE");
  assert.equal(started, 12);
  assert.equal(retiring.size, 12);
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
  // The new SAKU best-wall target is larger than this legacy row, so low
  // water replenishment replaces it even though it is not oversized.
  assert.equal(adopted!.active.get("SELL:0")?.needsNormalization, undefined);
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

// 2026-09-24 운영 사고: KABU가 SELL 먼저 재배치하던 중 API가 재시작돼 옛 매도 취소가
// "fetch failed"로 실패했다. 그 주문은 retiring에 남은 채 다시 취소되지 않았고,
// 재배치는 "옛 매도 종료 대기"에서 2시간 멈춰 매수 호가가 모두 사라졌다.
test("a cancel lost during an API restart is re-sent so a staged relocation cannot stall", async () => {
  const oldCenter = 113_800;
  const targetCenter = 114_500;
  const targetPlan = buildLiquidityLadder(KABU, targetCenter);
  const active = new Map<string, ManagedQuote>();
  const live = new Map<string, { side: "BUY" | "SELL"; price: number; qty: number }>();
  for (const quote of buildLiquidityLadder(KABU, oldCenter)) {
    const id = `old-${quote.side}-${quote.level}`;
    active.set(`${quote.side}:${quote.level}`, { ...quote, id });
    live.set(id, { side: quote.side, price: quote.price, qty: quote.qty });
  }
  const retiring = new Map<string, ManagedQuote>();
  let apiDown = true;
  let placed = 0;
  const client = {
    placeOrder: async (order: { side: "BUY" | "SELL"; price?: number; qty: number }) => {
      const id = `new-${placed++}`;
      live.set(id, { side: order.side, price: order.price!, qty: order.qty });
      return { id };
    },
    cancelOrder: async (id: string) => {
      // undici fetch가 연결 거부 시 던지는 것과 같은 오류 — ApiError(거절)가 아니다.
      if (apiDown) throw new TypeError("fetch failed");
      live.delete(id);
      return {};
    },
  };
  // 운영의 reconcileQuotes()처럼 계정 API가 본 live 목록으로 retiring을 정리한다.
  const reconcile = () => {
    for (const id of [...retiring.keys()]) if (!live.has(id)) retiring.delete(id);
  };
  const advance = () =>
    advanceStagedQuoteMigration(client as any, KABU.symbol, targetPlan, migration!, active, retiring, new Map(), new Map());

  const migration = beginStagedQuoteMigration(KABU, oldCenter, targetCenter);
  assert.equal(migration!.firstSide, "SELL");
  assert.equal(await advance(), "STAGING_FIRST_SIDE");
  reconcile();
  const stuck = [...retiring.keys()];
  assert.ok(stuck.length > 0, "the failed cancels leave old asks retiring");
  assert.equal(await advance(), "WAITING_FOR_FIRST_SIDE_RETIREMENT");

  apiDown = false;
  const attempts = new Map<string, number>();
  // 처음 본 시점은 기록만 하고, 재시도 간격이 지나기 전에는 다시 보내지 않는다.
  assert.equal(await retryStaleRetiringCancels(client as any, retiring, attempts, 10_000, 2_000), 0);
  assert.equal(await retryStaleRetiringCancels(client as any, retiring, attempts, 11_000, 2_000), 0);
  assert.equal(await retryStaleRetiringCancels(client as any, retiring, attempts, 12_000, 2_000), stuck.length);
  reconcile();
  assert.equal(retiring.size, 0);

  assert.equal(await advance(), "STAGING_SECOND_SIDE");
  assert.ok(sideMatchesPlan(active, targetPlan, "BUY"), "bids are restored");
  assert.equal(await advance(), "COMPLETE");
});

test("retrying retiring cancels tolerates rejections and transport errors", async () => {
  const quote = (id: string): ManagedQuote => ({ id, side: "SELL", level: 0, price: 120_100, qty: 10 });
  const retiring = new Map<string, ManagedQuote>([
    ["gone", quote("gone")],
    ["flaky", quote("flaky")],
  ]);
  const attempts = new Map<string, number>([
    ["gone", 0],
    ["flaky", 0],
    ["stale", 0],
  ]);
  const sent: string[] = [];
  const client = {
    cancelOrder: async (id: string) => {
      sent.push(id);
      // 이미 종결된 주문 취소는 422 — 정상 경로다.
      if (id === "gone") throw new ApiError(422, "already closed");
      throw new TypeError("fetch failed");
    },
  };
  assert.equal(await retryStaleRetiringCancels(client as any, retiring, attempts, 5_000, 2_000), 2);
  assert.deepEqual(sent.sort(), ["flaky", "gone"]);
  // 전송 실패도 루프를 멈추지 않고, 다음 간격에 다시 시도하도록 시각만 갱신한다.
  assert.equal(attempts.get("flaky"), 5_000);
  assert.equal(attempts.has("stale"), false, "entries no longer retiring are pruned");
  assert.equal(retiring.size, 2, "only reconciliation may drop a retiring guard");
});

// 원인과 무관한 최후 안전장치: 한쪽 자기 호가가 계속 0이면 MM을 다시 띄운다.
test("the one-sided quote watchdog fires only after a side stays empty for the limit", () => {
  const watchdog = new OneSidedQuoteWatchdog(60_000);
  const both = [{ side: "BUY" as const }, { side: "SELL" as const }];
  const asksOnly = [{ side: "SELL" as const }];

  assert.equal(watchdog.observe(both, 0), null);
  assert.equal(watchdog.observe(asksOnly, 1_000), null);
  assert.equal(watchdog.observe(asksOnly, 60_999), null);
  assert.equal(watchdog.observe(asksOnly, 61_000), "BUY");

  // 한 번이라도 다시 걸리면 시계가 초기화된다 — 정상적인 순간 공백은 재시작 사유가 아니다.
  watchdog.reset();
  assert.equal(watchdog.observe(asksOnly, 100_000), null);
  assert.equal(watchdog.observe(both, 130_000), null);
  assert.equal(watchdog.observe(asksOnly, 140_000), null);
  assert.equal(watchdog.observe(asksOnly, 199_999), null);
  assert.equal(watchdog.observe([], 200_000), "BUY");
});
