import { FUTURES, type FutureDef, type OrderSide } from "@mock-kabu/shared";
import type { ApiClient, LiveOrder } from "./client";

/** 선물 호가 단수(한쪽) — 현물보다 적게 둬 호가 교체 부하를 줄인다. */
export const FUTURES_LADDER_LEVELS = 5;
/** 중심이 이만큼(틱) 움직여야 호가를 옮긴다. 그 사이에는 비어 있는 칸만 채운다. */
export const FUTURES_RECENTER_TICKS = 2;
/** 재고 20계약마다 중심을 1틱 반대로 기울인다(최대 3틱). */
const INVENTORY_PER_SKEW_TICK = 20;
const MAX_SKEW_TICKS = 3;

const MM_LOOP_MS = 2_500;
const POSITION_REFRESH_MS = 10_000;
const OVERVIEW_REFRESH_MS = 2_000;

export interface FutureQuote {
  side: OrderSide;
  price: number;
  qty: number;
}

export interface FuturesOverviewRow {
  symbol: string;
  lastPrice: number;
  underlying: number | null;
}

function roundToTick(value: number, tick: number): number {
  return Math.max(tick, Math.round(value / tick) * tick);
}

/** 기초자산 가격과 재고로 호가 중심(정수 단위, 틱 위)을 정한다. */
export function futuresQuoteCenter(def: FutureDef, fairUnits: number, inventory: number): number {
  const skewTicks = Math.max(-MAX_SKEW_TICKS, Math.min(MAX_SKEW_TICKS, Math.trunc(inventory / INVENTORY_PER_SKEW_TICK)));
  return roundToTick(fairUnits, def.tickUnits) - skewTicks * def.tickUnits;
}

/** 중심 양쪽 1~N틱에 걸 호가. 안쪽은 얇고 바깥은 두껍게(2~6계약). */
export function planFuturesLadder(def: FutureDef, center: number): FutureQuote[] {
  const quotes: FutureQuote[] = [];
  for (let level = 1; level <= FUTURES_LADDER_LEVELS; level++) {
    const qty = level + 1;
    const bid = center - level * def.tickUnits;
    if (bid > 0) quotes.push({ side: "BUY", price: bid, qty });
    quotes.push({ side: "SELL", price: center + level * def.tickUnits, qty });
  }
  return quotes;
}

export interface LadderDiff {
  cancel: LiveOrder[];
  place: FutureQuote[];
}

/**
 * 원하는 호가와 지금 걸린 주문을 맞춘다. 가격·방향이 같은 주문은 그대로 두고(부분 체결이어도),
 * 원하는 목록에 없는 주문만 취소하며, 비어 있는 칸만 새로 건다 — 불필요한 취소·재접수를 만들지 않는다.
 */
export function diffFuturesLadder(desired: readonly FutureQuote[], live: readonly LiveOrder[]): LadderDiff {
  const key = (side: string, price: number | null) => `${side}:${price}`;
  const wanted = new Set(desired.map((quote) => key(quote.side, quote.price)));
  const present = new Set<string>();
  const cancel: LiveOrder[] = [];
  for (const order of live) {
    const k = key(order.side, order.price);
    if (order.type === "LIMIT" && wanted.has(k) && !present.has(k)) present.add(k);
    else cancel.push(order);
  }
  return { cancel, place: desired.filter((quote) => !present.has(key(quote.side, quote.price))) };
}

/** 봇 프로세스 안에서 선물 시세·기초자산을 한 번만 읽어 나눠 쓴다(API도 2초 캐시). */
export class FuturesMarketView {
  private rows = new Map<string, FuturesOverviewRow>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly client: ApiClient) {}

  start(): void {
    const load = () =>
      this.client
        .futuresOverview()
        .then((rows) => {
          this.rows = new Map(rows.map((row) => [row.symbol, row]));
        })
        .catch((error) => console.warn("[futures] overview failed", error instanceof Error ? error.message : error));
    void load();
    this.timer = setInterval(load, OVERVIEW_REFRESH_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** 기초자산 값(없으면 선물 최근가) */
  fair(symbol: string): number | null {
    const row = this.rows.get(symbol);
    if (!row) return null;
    return row.underlying ?? row.lastPrice;
  }

  last(symbol: string): number | null {
    return this.rows.get(symbol)?.lastPrice ?? null;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 선물 1종목 전담 마켓메이커(bot34~38). */
export async function runFuturesMarketMaker(client: ApiClient, def: FutureDef, market: FuturesMarketView): Promise<void> {
  let inventory = 0;
  let inventoryAt = 0;
  let lastCenter: number | null = null;
  while (true) {
    try {
      const fair = market.fair(def.symbol);
      if (fair != null) {
        if (Date.now() - inventoryAt > POSITION_REFRESH_MS) {
          const account = await client.futuresPositions();
          inventory = account.positions.find((p) => p.symbol === def.symbol)?.qty ?? 0;
          inventoryAt = Date.now();
        }
        const center = futuresQuoteCenter(def, fair, inventory);
        const state = await client.quoteState(def.symbol);
        const recenter: boolean = lastCenter == null || Math.abs(center - lastCenter) >= FUTURES_RECENTER_TICKS * def.tickUnits;
        const effectiveCenter: number = recenter ? center : (lastCenter as number);
        const diff = diffFuturesLadder(planFuturesLadder(def, effectiveCenter), state.orders);
        for (const order of diff.cancel) await client.cancelOrder(order.id).catch(() => undefined);
        for (const quote of diff.place) {
          await client.placeOrder({ symbol: def.symbol, side: quote.side, type: "LIMIT", price: quote.price, qty: quote.qty })
            .catch((error) => console.warn(`[futures-mm:${def.symbol}] place failed`, error instanceof Error ? error.message : error));
        }
        lastCenter = effectiveCenter;
      }
    } catch (error) {
      console.warn(`[futures-mm:${def.symbol}]`, error instanceof Error ? error.message : error);
    }
    await sleep(MM_LOOP_MS);
  }
}

/** 선물 거래 흐름: 가끔 시장가 1~3계약. 기초자산 쪽으로 되돌리는 방향을 65%로 고른다. */
export async function runFuturesTrader(client: ApiClient, market: FuturesMarketView, name: string): Promise<void> {
  const MAX_POSITION = 20;
  while (true) {
    await sleep(5_000 + Math.random() * 10_000);
    try {
      const def = FUTURES[Math.floor(Math.random() * FUTURES.length)];
      const fair = market.fair(def.symbol);
      const last = market.last(def.symbol);
      if (fair == null || last == null) continue;
      const account = await client.futuresPositions();
      const position = account.positions.find((p) => p.symbol === def.symbol)?.qty ?? 0;
      let side: OrderSide = fair >= last ? "BUY" : "SELL";
      if (Math.random() > 0.65) side = side === "BUY" ? "SELL" : "BUY";
      // 한쪽으로 너무 쌓였으면 줄이는 쪽으로만.
      if (position >= MAX_POSITION) side = "SELL";
      if (position <= -MAX_POSITION) side = "BUY";
      const qty = 1 + Math.floor(Math.random() * 3);
      await client.placeOrder({ symbol: def.symbol, side, type: "MARKET", qty });
    } catch (error) {
      console.warn(`[futures:${name}]`, error instanceof Error ? error.message : error);
    }
  }
}
