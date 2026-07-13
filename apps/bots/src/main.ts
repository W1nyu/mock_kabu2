import "./env";
import { SYMBOLS, type OrderSide, type SymbolDef } from "@mock-kabu/shared";
import { ApiClient, isRejection } from "./client";
import { MarketMakerStartupBlockedError, runMarketMaker } from "./market-maker";
import { MarketModel, referencePriceFromHistory } from "./market-model";
import {
  chooseBookLevelIndex,
  chooseMarketTakerQuantity,
  priceScaledShares,
  VolumeActivity,
  type TakerQuantityDecision,
} from "./volume-activity";

const BOT_PASSWORD = "botpassword";
const LIQUIDITY_BOT_PASSWORD = process.env.LIQUIDITY_BOT_PASSWORD ?? BOT_PASSWORD;
// Generation 1 (bot11..bot15) can be polluted in an existing local DB before
// the current matching recovery code is running. Keep it untouched and use a
// clean dedicated generation rather than mutating historical orders.
const LIQUIDITY_BOT_START_INDEX = 16;
const LIQUIDITY_REBALANCE_MS = 30_000;
/** Passive additions stay useful without consuming a bot's whole balance. */
const MAX_PASSIVE_ORDER_NOTIONAL = 8_000_000;

const rand = (min: number, max: number) => min + Math.random() * (max - min);
const randInt = (min: number, max: number) => Math.floor(rand(min, max + 1));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Restore the reference model from durable prices instead of a fresh IPO price. */
async function restoreReferencePrices(client: ApiClient): Promise<Map<string, number>> {
  const persistedPrices = new Map<string, number>();
  try {
    for (const row of await client.marketSymbols()) {
      persistedPrices.set(row.symbol, row.lastPrice);
    }
  } catch (error) {
    console.warn("[bots] could not load persisted market prices; checking recent trades only", error);
  }

  const latestTrades = await Promise.all(
    SYMBOLS.map(async (symbol) => {
      try {
        const [trade] = await client.recentTrades(symbol.symbol, 1);
        return [symbol.symbol, trade?.price] as const;
      } catch (error) {
        console.warn(`[bots] could not load latest trade for ${symbol.symbol}; using cache`, error);
        return [symbol.symbol, undefined] as const;
      }
    }),
  );

  return new Map(
    SYMBOLS.map((symbol) => {
      const latestTradePrice = latestTrades.find(([key]) => key === symbol.symbol)?.[1];
      return [
        symbol.symbol,
        referencePriceFromHistory(
          symbol.initialPrice,
          persistedPrices.get(symbol.symbol),
          latestTradePrice,
        ),
      ] as const;
    }),
  );
}

function toTick(price: number, def: SymbolDef): number {
  return Math.max(def.tickSize, Math.round(price / def.tickSize) * def.tickSize);
}

function passiveQty(
  activity: VolumeActivity,
  sample: ReturnType<VolumeActivity["sample"]>,
  price: number,
  minSharesAtReference: number,
  maxSharesAtReference: number,
): number {
  const safePrice = Math.max(1, price);
  const min = priceScaledShares(minSharesAtReference, safePrice);
  const max = Math.max(min, priceScaledShares(maxSharesAtReference, safePrice));
  const notionalCap = Math.max(1, Math.floor(MAX_PASSIVE_ORDER_NOTIONAL / safePrice));
  return activity.quantityFor(sample, min, max, notionalCap);
}

/**
 * Use the actual executable side of the live book. Most calls return a
 * sub-wall print; a random minority walks up to the nearest three levels.
 * That makes a quoted wall something bots can genuinely consume, not merely
 * replenish forever.
 */
async function liveMarketQty(
  client: ApiClient,
  def: SymbolDef,
  side: OrderSide,
  referencePrice: number,
  sample: ReturnType<VolumeActivity["sample"]>,
  minSharesAtReference: number,
  maxSharesAtReference: number,
  sweepChance: number,
): Promise<TakerQuantityDecision> {
  try {
    const book = await client.orderbook(def.symbol);
    const levels = side === "BUY" ? book.asks : book.bids;
    return chooseMarketTakerQuantity({
      price: levels[0]?.price ?? referencePrice,
      levelQtys: levels.map((level) => level.qty),
      minSharesAtReference,
      maxSharesAtReference,
      intensity: sample.intensity,
      sweepChance,
    });
  } catch {
    // If a snapshot is temporarily unavailable, retain price-scaled ordinary
    // flow rather than emitting a large blind market order.
    return chooseMarketTakerQuantity({
      price: referencePrice,
      levelQtys: [],
      minSharesAtReference,
      maxSharesAtReference,
      intensity: sample.intensity,
      sweepChance: 0,
    });
  }
}

/**
 * One small, unbiased taker per symbol keeps executions flowing even when the
 * liquidity walls themselves are healthy. Its activity is stochastic, but it
 * never imposes an upward or downward price rule.
 */
async function runRandomFlowTrader(
  client: ApiClient,
  def: SymbolDef,
  ref: MarketModel,
  activity: VolumeActivity,
  name: string,
) {
  while (true) {
    const sample = activity.sample(def.symbol);
    try {
      const side: OrderSide = Math.random() < 0.5 ? "BUY" : "SELL";
      const { qty } = await liveMarketQty(client, def, side, ref.get(def.symbol), sample, 1, 18, 0.28);
      await client.placeOrder({
        symbol: def.symbol,
        side,
        type: "MARKET",
        qty,
      });
    } catch (error) {
      if (!isRejection(error)) console.error(`[random-flow:${name}]`, error instanceof Error ? error.message : error);
    }
    await sleep(activity.delayFor(sample, 900, 3_800, 450));
  }
}

/** Small retail flow: mostly tiny, occasionally marketable orders. */
async function runRetailTrader(client: ApiClient, ref: MarketModel, activity: VolumeActivity, name: string) {
  while (true) {
    const def = SYMBOLS[randInt(0, SYMBOLS.length - 1)];
    const sample = activity.sample(def.symbol);
    try {
      let side: OrderSide = Math.random() < 0.5 ? "BUY" : "SELL";
      const trades = await client.recentTrades(def.symbol, 6);
      if (trades.length >= 3) {
        const up = trades[0].price >= trades[trades.length - 1].price;
        side = Math.random() < 0.65 ? (up ? "BUY" : "SELL") : up ? "SELL" : "BUY";
      }

      if (Math.random() < 0.5) {
        const { qty } = await liveMarketQty(client, def, side, ref.get(def.symbol), sample, 1, 5, 0.18);
        await client.placeOrder({ symbol: def.symbol, side, type: "MARKET", qty });
      } else {
        const drift = side === "BUY" ? rand(0.997, 1.001) : rand(0.999, 1.003);
        const price = toTick(ref.get(def.symbol) * drift, def);
        await client.placeOrder({
          symbol: def.symbol,
          side,
          type: "LIMIT",
          price,
          qty: passiveQty(activity, sample, price, 1, 5),
        });
      }
    } catch (error) {
      if (!isRejection(error)) console.error(`[retail:${name}]`, error instanceof Error ? error.message : error);
    }
    await sleep(activity.delayFor(sample, 1_000, 3_500, 500));
  }
}

/** Infrequent bounded flow adds occasional activity without clearing a wall. */
async function runWhale(client: ApiClient, ref: MarketModel, activity: VolumeActivity, name: string) {
  let nextDelayMs = rand(15_000, 45_000);
  while (true) {
    await sleep(nextDelayMs);
    const def = SYMBOLS[randInt(0, SYMBOLS.length - 1)];
    const sample = activity.sample(def.symbol);
    nextDelayMs = activity.delayFor(sample, 15_000, 45_000, 7_000);
    try {
      const side: OrderSide = Math.random() < 0.5 ? "BUY" : "SELL";
      let qty: number;
      let sweep = false;
      if (Math.random() < 0.42) {
        const decision = await liveMarketQty(client, def, side, ref.get(def.symbol), sample, 8, 90, 0.52);
        qty = decision.qty;
        sweep = decision.sweepsBest;
        await client.placeOrder({ symbol: def.symbol, side, type: "MARKET", qty });
      } else {
        const drift = side === "BUY" ? 1.002 : 0.998;
        const price = toTick(ref.get(def.symbol) * drift, def);
        qty = passiveQty(activity, sample, price, 8, 90);
        await client.placeOrder({
          symbol: def.symbol,
          side,
          type: "LIMIT",
          price,
          qty,
        });
      }
      console.log(`[whale:${name}] ${def.symbol} ${side} ${qty} shares${sweep ? " (walk)" : ""}`);
    } catch (error) {
      if (!isRejection(error)) console.error(`[whale:${name}]`, error instanceof Error ? error.message : error);
    }
  }
}

/** Random low-volume noise flow. */
async function runNoiseTrader(client: ApiClient, ref: MarketModel, activity: VolumeActivity, name: string) {
  while (true) {
    const def = SYMBOLS[randInt(0, SYMBOLS.length - 1)];
    const sample = activity.sample(def.symbol);
    try {
      const side: OrderSide = Math.random() < 0.5 ? "BUY" : "SELL";
      if (Math.random() < 0.4) {
        const { qty } = await liveMarketQty(client, def, side, ref.get(def.symbol), sample, 1, 10, 0.16);
        await client.placeOrder({ symbol: def.symbol, side, type: "MARKET", qty });
      } else {
        const drift = side === "BUY" ? rand(0.995, 1.002) : rand(0.998, 1.005);
        const price = toTick(ref.get(def.symbol) * drift, def);
        await client.placeOrder({
          symbol: def.symbol,
          side,
          type: "LIMIT",
          price,
          qty: passiveQty(activity, sample, price, 1, 10),
        });
      }
    } catch (error) {
      if (!isRejection(error)) console.error(`[noise:${name}]`, error instanceof Error ? error.message : error);
    }
    await sleep(activity.delayFor(sample, 700, 2_500, 400));
  }
}

/** A small trend follower based on recent durable trades. */
async function runMomentumTrader(client: ApiClient, ref: MarketModel, activity: VolumeActivity, name: string) {
  while (true) {
    const def = SYMBOLS[randInt(0, SYMBOLS.length - 1)];
    const sample = activity.sample(def.symbol);
    try {
      const trades = await client.recentTrades(def.symbol, 10);
      if (trades.length >= 5) {
        const latest = trades[0].price;
        const oldest = trades[trades.length - 1].price;
        const momentum = (latest - oldest) / oldest;
        if (Math.abs(momentum) > 0.001) {
          const side: OrderSide = momentum > 0 ? "BUY" : "SELL";
          const { qty } = await liveMarketQty(client, def, side, ref.get(def.symbol), sample, 1, 5, 0.36);
          await client.placeOrder({
            symbol: def.symbol,
            side,
            type: "MARKET",
            qty,
          });
        }
      }
    } catch (error) {
      if (!isRejection(error)) console.error(`[momentum:${name}]`, error instanceof Error ? error.message : error);
    }
    await sleep(activity.delayFor(sample, 2_500, 4_500, 750));
  }
}

/**
 * Adds and removes this bot's passive orders at random visible levels. This
 * intentionally targets the entire depth ladder (usually levels 2..10), so
 * displayed walls breathe instead of only changing at best bid/ask.
 */
async function runDepthShaper(client: ApiClient, ref: MarketModel, activity: VolumeActivity, name: string) {
  const placedOrderIds: string[] = [];
  while (true) {
    const def = SYMBOLS[randInt(0, SYMBOLS.length - 1)];
    const sample = activity.sample(def.symbol);
    try {
      const shouldRemove = placedOrderIds.length > 0 && (Math.random() < 0.38 || placedOrderIds.length >= 36);
      if (shouldRemove) {
        const index = randInt(0, placedOrderIds.length - 1);
        const [orderId] = placedOrderIds.splice(index, 1);
        await client.cancelOrder(orderId).catch(() => {});
      } else {
        const side: OrderSide = Math.random() < 0.5 ? "BUY" : "SELL";
        const book = await client.orderbook(def.symbol);
        const levels = side === "BUY" ? book.bids : book.asks;
        if (levels.length > 0) {
          const level = levels[chooseBookLevelIndex(Math.min(10, levels.length))];
          const placed = await client.placeOrder({
            symbol: def.symbol,
            side,
            type: "LIMIT",
            price: level.price,
            qty: passiveQty(activity, sample, level.price, 2, 16),
          });
          placedOrderIds.push(placed.id);
        }
      }
    } catch (error) {
      if (!isRejection(error)) console.error(`[depth-shaper:${name}]`, error instanceof Error ? error.message : error);
    }
    await sleep(activity.delayFor(sample, 1_000, 4_800, 600));
  }
}

/** Keeps non-market-maker bot accounts from accumulating a large stale order tail. */
async function runJanitor(clients: ApiClient[]) {
  while (true) {
    await sleep(30_000);
    for (const client of clients) {
      try {
        const orders = await client.myOrders(100);
        for (const order of orders.filter((order) => ["OPEN", "PARTIAL"].includes(order.status)).slice(10)) {
          await client.cancelOrder(order.id).catch(() => {});
        }
      } catch {
        // The next cleanup pass retries.
      }
    }
  }
}

/** Provision clean bot16..bot20 reserves before they need to authenticate. */
async function ensureLiquidityReserves(): Promise<void> {
  const bootstrap = new ApiClient("liquidity-bootstrap@internal");
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await bootstrap.ensureLiquidityReserves();
      console.log(
        `[bots] liquidity reserves ready: ${result.reserves
          .map((reserve) => `${reserve.symbol}${reserve.created ? "(new)" : ""}`)
          .join(", ")}`,
      );
      return;
    } catch (error) {
      if (attempt >= 30) throw error;
      console.warn(`[bots] liquidity reserve bootstrap retrying (${attempt})...`);
      await sleep(2_000);
    }
  }
}

/** Keep reserve buying power and inventory above the executable depth floor. */
function scheduleLiquidityReserveRebalance() {
  const bootstrap = new ApiClient("liquidity-rebalance@internal");
  let inFlight = false;
  setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void bootstrap
      .ensureLiquidityReserves()
      .catch((error) => {
        console.warn(
          "[bots] scheduled liquidity rebalance failed; the next interval will retry",
          error instanceof Error ? error.message : error,
        );
      })
      .finally(() => {
        inFlight = false;
      });
  }, LIQUIDITY_REBALANCE_MS);
}

/**
 * A reserve account is isolated from bot1..bot10 history. If a transient
 * cancel/query failure nevertheless blocks its startup, re-provision its
 * available cash/inventory and retry the same dedicated owner with backoff.
 * No legacy order or user account is altered as part of this recovery.
 */
async function runDedicatedMarketMaker(client: ApiClient, def: SymbolDef, ref: MarketModel) {
  let retryMs = 1_000;
  while (true) {
    try {
      // This runner is invoked only for the fixed bot16..bot20 reserve
      // generation.  Legacy/user makers retain runMarketMaker's fail-closed
      // startup behavior and can never preserve an unretirable order here.
      await runMarketMaker(client, def, ref, { allowUnretirableReserveFallback: true });
      return;
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      const kind = error instanceof MarketMakerStartupBlockedError ? "startup blocked" : "stopped";
      console.error(`[bots] ${def.symbol} dedicated maker ${kind}: ${cause}; recovering`);
    }

    try {
      await client.ensureLiquidityReserves();
      await client.login(LIQUIDITY_BOT_PASSWORD);
      retryMs = 1_000;
    } catch (error) {
      console.error(
        `[bots] ${def.symbol} reserve recovery request failed`,
        error instanceof Error ? error.message : error,
      );
    }
    await sleep(retryMs);
    retryMs = Math.min(retryMs * 2, 15_000);
  }
}

async function main() {
  await ensureLiquidityReserves();

  console.log("[bots] logging in legacy flow accounts and dedicated liquidity accounts...");
  const clients: ApiClient[] = [];
  for (let index = 1; index <= 10; index++) {
    const client = new ApiClient(`bot${index}@bots.local`);
    for (let attempt = 1; ; attempt++) {
      try {
        await client.login(BOT_PASSWORD);
        break;
      } catch (error) {
        if (attempt >= 30) throw error;
        console.log(`[bots] api not ready, retrying (${attempt})...`);
        await sleep(2_000);
      }
    }
    clients.push(client);
  }

  const liquidityClients: ApiClient[] = [];
  for (let index = 0; index < SYMBOLS.length; index++) {
    const client = new ApiClient(`bot${LIQUIDITY_BOT_START_INDEX + index}@bots.local`);
    for (let attempt = 1; ; attempt++) {
      try {
        await client.login(LIQUIDITY_BOT_PASSWORD);
        break;
      } catch (error) {
        if (attempt >= 30) throw error;
        console.log(`[bots] liquidity login retrying (${attempt})...`);
        await sleep(2_000);
      }
    }
    liquidityClients.push(client);
  }

  const restoredPrices = await restoreReferencePrices(clients[0]);
  const ref = new MarketModel(SYMBOLS, { initialPrices: restoredPrices });
  const activity = new VolumeActivity(SYMBOLS.map((symbol) => symbol.symbol));
  console.log(
    `[bots] restored reference prices: ${[...restoredPrices.entries()]
      .map(([symbol, price]) => `${symbol}=${price}`)
      .join(", ")}`,
  );
  setInterval(() => ref.tick(), 1_500);

  // Dedicated bot16..bot20 reserve accounts each own exactly one symbol's
  // ladder. Existing bot1..bot10 order history is left untouched.
  SYMBOLS.forEach((def, index) => void runDedicatedMarketMaker(liquidityClients[index], def, ref));
  scheduleLiquidityReserveRebalance();
  // Bots 1-5: one small unbiased taker per symbol. This produces real trades
  // without coupling trade volume to a price-direction mechanism.
  SYMBOLS.forEach((def, index) => void runRandomFlowTrader(clients[index], def, ref, activity, `bot${index + 1}`));
  // Bots 6-7: small trend-following retail flow.
  for (let index = 5; index < 7; index++) void runRetailTrader(clients[index], ref, activity, `bot${index + 1}`);
  // Bot 8: bounded large-trader flow.
  void runWhale(clients[7], ref, activity, "bot8");
  // Bot 9: random low-volume flow.
  void runNoiseTrader(clients[8], ref, activity, "bot9");
  // Bot 9 also adds/cancels its own passive orders across the visible ladder.
  // This makes non-best depth breathe without mutating reserve ownership.
  void runDepthShaper(clients[8], ref, activity, "bot9");
  // Bot 10: momentum flow.
  void runMomentumTrader(clients[9], ref, activity, "bot10");
  void runJanitor(clients.slice(5));

  console.log(
    "[bots] dedicated market makers x5, unbiased flow x5, retail x2, whale x1, noise x1, depth shaper x1, momentum x1 running",
  );
}

main().catch((error) => {
  console.error("[bots] fatal", error);
  process.exit(1);
});
