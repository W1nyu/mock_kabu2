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
const HISTORY_MS = 5 * 60_000;
/** 아직 살아 있는 주문에 취소를 다시 보내는 간격(API도 30초 안의 중복 취소는 버린다) */
const CANCEL_RESEND_MS = 30_000;

export interface FutureQuote {
  side: OrderSide;
  price: number;
  qty: number;
}

/** 계좌 선물 요약 중 봇이 위험 판단에 쓰는 부분 (`/account/futures`) */
export interface FuturesAccountView {
  positions: { symbol: string; qty: number }[];
  equity?: number;
  maintenanceMargin?: number;
  marginCall?: unknown | null;
}

/**
 * 거래 봇의 위험 모드. 추가증거금이 걸렸거나 평가예탁금이 유지증거금의 2배 아래면 새로 쌓지 않고 줄이기만 한다
 * — 봇이 반대매매를 당해 시장가를 한꺼번에 던지는 일을 줄인다.
 */
export function futuresRiskMode(account: FuturesAccountView): "normal" | "reduce" {
  if (account.marginCall) return "reduce";
  const maintenance = Number(account.maintenanceMargin ?? 0);
  const equity = Number(account.equity ?? 0);
  if (maintenance > 0 && equity < maintenance * 2) return "reduce";
  return "normal";
}

/** 기초자산이 짧은 창에서 이만큼(bps) 움직이면 모멘텀 신호로 본다 — 기초자산 변동성에 맞춘 값. */
export const MOMENTUM_THRESHOLD_BPS: Record<string, number> = {
  KABU_INDEX: 20,
  USDKRW: 10,
  OIL: 40,
  GAS: 70,
  COPPER: 30,
};

/** 창 안 변화율(bps)이 문턱을 넘으면 그 방향, 아니면 null. */
export function futuresMomentumSide(changeBps: number | null, thresholdBps: number): OrderSide | null {
  if (changeBps == null || !Number.isFinite(changeBps)) return null;
  if (changeBps >= thresholdBps) return "BUY";
  if (changeBps <= -thresholdBps) return "SELL";
  return null;
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
  /** 기초자산 값 기록(모멘텀 판단용, 최근 5분) */
  private history = new Map<string, { ts: number; value: number }[]>();

  constructor(private readonly client: ApiClient) {}

  start(): void {
    const load = () =>
      this.client
        .futuresOverview()
        .then((rows) => {
          this.rows = new Map(rows.map((row) => [row.symbol, row]));
          const now = Date.now();
          for (const row of rows) if (row.underlying != null) this.record(row.symbol, now, row.underlying);
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

  record(symbol: string, ts: number, value: number): void {
    const list = this.history.get(symbol) ?? [];
    list.push({ ts, value });
    while (list.length > 0 && list[0].ts < ts - HISTORY_MS) list.shift();
    this.history.set(symbol, list);
  }

  /** windowMs 전 값 대비 지금 기초자산 변화율(bps). 기록이 모자라면 null. */
  changeBps(symbol: string, windowMs: number, now = Date.now()): number | null {
    const list = this.history.get(symbol);
    if (!list || list.length < 2) return null;
    const latest = list[list.length - 1];
    let past: { ts: number; value: number } | undefined;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].ts <= now - windowMs) {
        past = list[i];
        break;
      }
    }
    if (!past || past.value <= 0) return null;
    return ((latest.value - past.value) / past.value) * 10_000;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 선물 1종목 전담 마켓메이커(bot34~38). */
export async function runFuturesMarketMaker(client: ApiClient, def: FutureDef, market: FuturesMarketView): Promise<void> {
  let inventory = 0;
  let inventoryAt = 0;
  let lastCenter: number | null = null;
  // 취소는 비동기라 한동안 살아 있는 주문으로 보인다. 같은 주문에 취소를 매 루프 다시 보내지 않는다.
  const cancelSentAt = new Map<string, number>();
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
        const now = Date.now();
        const liveIds = new Set(state.orders.map((order) => order.id));
        for (const id of [...cancelSentAt.keys()]) if (!liveIds.has(id)) cancelSentAt.delete(id);
        for (const order of diff.cancel) {
          if (now - (cancelSentAt.get(order.id) ?? 0) < CANCEL_RESEND_MS) continue;
          cancelSentAt.set(order.id, now);
          await client.cancelOrder(order.id).catch(() => undefined);
        }
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

/** 쌓인 포지션 하나를 0 쪽으로 1~3계약 줄이는 주문. 포지션이 없으면 null. */
export function reduceOrder(
  positions: readonly { symbol: string; qty: number }[],
  rand: () => number = Math.random,
): { symbol: string; side: OrderSide; qty: number } | null {
  const open = positions.filter((p) => p.qty !== 0);
  if (open.length === 0) return null;
  const pick = open[Math.floor(rand() * open.length)];
  return { symbol: pick.symbol, side: pick.qty > 0 ? "SELL" : "BUY", qty: Math.min(Math.abs(pick.qty), 1 + Math.floor(rand() * 3)) };
}

/** 선물 거래 흐름: 가끔 시장가 1~3계약. 기초자산 쪽으로 되돌리는 방향을 65%로 고른다. 위험하면 줄이기만 한다. */
export async function runFuturesTrader(client: ApiClient, market: FuturesMarketView, name: string): Promise<void> {
  const MAX_POSITION = 20;
  while (true) {
    await sleep(5_000 + Math.random() * 10_000);
    try {
      const account = (await client.futuresPositions()) as FuturesAccountView;
      if (futuresRiskMode(account) === "reduce") {
        const order = reduceOrder(account.positions);
        if (order) await client.placeOrder({ ...order, type: "MARKET" });
        continue;
      }
      const def = FUTURES[Math.floor(Math.random() * FUTURES.length)];
      const fair = market.fair(def.symbol);
      const last = market.last(def.symbol);
      if (fair == null || last == null) continue;
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

const MOMENTUM_WINDOW_MS = 90_000;

function momentumSignal(market: FuturesMarketView, def: FutureDef, now: number): OrderSide | null {
  return futuresMomentumSide(market.changeBps(def.symbol, MOMENTUM_WINDOW_MS, now), MOMENTUM_THRESHOLD_BPS[def.underlying] ?? 30);
}

/**
 * 선물 모멘텀(뉴스 반응): 기초자산이 90초 동안 문턱 이상 움직이면 그 방향으로 1~3계약 시장가 진입하고,
 * 3~8분 뒤 청산한다. 뉴스가 기초자산을 밀면 선물도 따라가는 흐름을 만든다. 신호가 없으면 API를 부르지 않는다.
 */
export async function runFuturesMomentumTrader(client: ApiClient, market: FuturesMarketView, name: string): Promise<void> {
  const MAX_POSITION = 10;
  const exitAt = new Map<string, number>();
  while (true) {
    await sleep(8_000 + Math.random() * 8_000);
    try {
      const now = Date.now();
      const due = [...exitAt.entries()].find(([, at]) => at <= now)?.[0] ?? null;
      const signals = FUTURES.filter((def) => momentumSignal(market, def, now) != null);
      if (due == null && signals.length === 0) continue;
      const account = (await client.futuresPositions()) as FuturesAccountView;

      // 보유 기간이 끝났거나 위험하면 청산부터.
      if (due != null || futuresRiskMode(account) === "reduce") {
        if (due != null) exitAt.delete(due);
        const position = account.positions.find((p) => p.symbol === due);
        const order =
          position && position.qty !== 0
            ? { symbol: position.symbol, side: (position.qty > 0 ? "SELL" : "BUY") as OrderSide, qty: Math.abs(position.qty) }
            : reduceOrder(account.positions);
        if (order) await client.placeOrder({ ...order, type: "MARKET" });
        continue;
      }

      for (const def of signals) {
        const side = momentumSignal(market, def, now);
        if (!side || Math.random() > 0.5) continue;
        const position = account.positions.find((p) => p.symbol === def.symbol)?.qty ?? 0;
        if ((side === "BUY" && position >= MAX_POSITION) || (side === "SELL" && position <= -MAX_POSITION)) continue;
        const qty = 1 + Math.floor(Math.random() * 3);
        await client.placeOrder({ symbol: def.symbol, side, type: "MARKET", qty });
        exitAt.set(def.symbol, now + 3 * 60_000 + Math.random() * 5 * 60_000);
        break;
      }
    } catch (error) {
      console.warn(`[futures-momentum:${name}]`, error instanceof Error ? error.message : error);
    }
  }
}
