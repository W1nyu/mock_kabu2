import { FUTURES, futureMarginPerContract, MARKET_BUY_HOLD_FACTOR, type FutureDef, type OrderSide } from "@mock-kabu/shared";
import type { ApiClient, LiveOrder } from "./client";

/** 선물 호가 단수(한쪽) — 화면은 5단을 보이고, 안쪽이 체결돼도 5단이 차 있게 2단을 더 둔다. */
export const FUTURES_LADDER_LEVELS = 7;
/** 단별 기본 수량(안쪽 → 바깥). 한쪽 합계 약 42계약(예전 5단 40계약과 비슷한 증거금). */
const FUTURES_LEVEL_QTY = [3, 4, 5, 6, 7, 8, 9] as const;
/** 체결로 남은 수량이 원하는 수량의 이 비율 아래로 줄면 그 단을 다시 채운다(현물 마켓메이커 0.45와 비슷하게). */
const FUTURES_REFILL_RATIO = 0.4;
/**
 * 중심이 멀리 벗어나도 한 루프에 이만큼(칸)만, 또는 남은 거리의 1/3만 옮긴다 — 현물 호가처럼 미끄러지듯 따라간다.
 * 한 번에 통째로 옮기면 호가 전체가 취소·재접수돼 그 사이 호가창이 비었다.
 */
const MAX_GLIDE_STEPS = 2;
/** 중심이 이만큼(호가 간격) 움직여야 호가를 옮긴다. 그 사이에는 비어 있는 칸만 채운다. */
export const FUTURES_RECENTER_STEPS = 2;
/** 호가 간격의 목표 크기(bps). 틱이 이보다 훨씬 잘면(KABUF 0.05pt ≈ 0.4bp) 여러 틱을 한 칸으로 쓴다. */
const LADDER_STEP_BPS = 1;
/**
 * 마켓메이커가 보는 기초자산 = 최근 이 시간 평균. KABU 지수는 현물 최근가로 계산해 호가 사이 체결이 튈 때마다
 * 2초 만에 ±1pt(수십 틱)씩 오르내린다 — 그대로 따라가면 매 루프 호가 전체를 취소·재접수해 호가창이 비고 널뛴다.
 */
export const FUTURES_FAIR_WINDOW_MS = 20_000;
/** 재고 20계약마다 중심을 1틱 반대로 기울인다(최대 3틱). */
const INVENTORY_PER_SKEW_TICK = 20;
const MAX_SKEW_TICKS = 3;

const MM_LOOP_MS = 2_000;
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
  KABU_INDEX: 12,
  USDKRW: 6,
  OIL: 25,
  GAS: 45,
  COPPER: 18,
  GOLD: 12,
  CORN: 22,
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

/**
 * 가격마다 고정된 수량 흔들림(×0.7~1.3). 같은 가격을 다시 걸어도 수량이 같아 불필요한 재접수가 없고,
 * 단마다 수량이 달라 4·6·8·10·12처럼 기계적으로 보이지 않는다.
 */
export function jitteredQty(base: number, key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
  const unit = ((hash >>> 0) % 1000) / 1000;
  return Math.max(1, Math.round(base * (0.7 + unit * 0.6)));
}

/** 지난 중심에서 목표 중심 쪽으로 이번 루프에 옮길 중심 — 최대 MAX_GLIDE_STEPS칸 또는 남은 거리의 1/3(더 큰 쪽). */
export function glideCenter(previous: number, target: number, step: number): number {
  const gapSteps = Math.round((target - previous) / step);
  const move = Math.min(Math.abs(gapSteps), Math.max(MAX_GLIDE_STEPS, Math.ceil(Math.abs(gapSteps) / 3)));
  return previous + Math.sign(gapSteps) * move * step;
}

/**
 * 아직 살아 있는 반대편 주문(취소를 보냈어도 엔진이 처리하기 전)과 가격이 겹치는 새 호가는 이번에 내지 않는다
 * — 자기 주문끼리 체결되지 않게. 취소가 끝나면 다음 루프에 걸린다.
 */
export function withoutSelfCross<T extends { side: OrderSide; price: number }>(quotes: readonly T[], live: readonly LiveOrder[]): T[] {
  let lowestAsk = Infinity;
  let highestBid = -Infinity;
  for (const order of live) {
    if (order.price == null) continue;
    if (order.side === "SELL") lowestAsk = Math.min(lowestAsk, order.price);
    else highestBid = Math.max(highestBid, order.price);
  }
  return quotes.filter((quote) => (quote.side === "BUY" ? quote.price < lowestAsk : quote.price > highestBid));
}

/** 호가 한 칸(정수 단위) — 틱의 정수배로 가격의 약 1bp. 대부분 1틱이고 KABUF만 여러 틱이다. */
export function futuresLadderStep(def: FutureDef, center: number): number {
  return def.tickUnits * Math.max(1, Math.round((center * LADDER_STEP_BPS) / 10_000 / def.tickUnits));
}

/**
 * 중심 양쪽 1~N칸에 걸 호가. 안쪽은 얇고 바깥은 두껍게(단별 3~9계약 ×0.7~1.3) — 거래 봇이 한 번에 최대 5계약을
 * 가져가도 다음 호가 교체까지 한쪽이 비지 않게 한다.
 */
export function planFuturesLadder(def: FutureDef, center: number, step = futuresLadderStep(def, center)): FutureQuote[] {
  const quotes: FutureQuote[] = [];
  for (let level = 1; level <= FUTURES_LADDER_LEVELS; level++) {
    const base = FUTURES_LEVEL_QTY[level - 1];
    const bid = center - level * step;
    const ask = center + level * step;
    if (bid > 0) quotes.push({ side: "BUY", price: bid, qty: jitteredQty(base, `${def.symbol}:B:${bid}`) });
    quotes.push({ side: "SELL", price: ask, qty: jitteredQty(base, `${def.symbol}:S:${ask}`) });
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
 * `minRemainingRatio`를 주면 남은 수량이 원하는 수량 × 비율보다 적은 주문은 취소하고 다시 건다(옵션 호가 수량 보충).
 */
export function diffFuturesLadder(desired: readonly FutureQuote[], live: readonly LiveOrder[], minRemainingRatio = 0): LadderDiff {
  const key = (side: string, price: number | null) => `${side}:${price}`;
  const wanted = new Map(desired.map((quote) => [key(quote.side, quote.price), quote.qty]));
  const present = new Set<string>();
  const cancel: LiveOrder[] = [];
  for (const order of live) {
    const k = key(order.side, order.price);
    const want = wanted.get(k);
    const enough = want != null && order.qty - order.filledQty >= want * minRemainingRatio;
    if (order.type === "LIMIT" && enough && !present.has(k)) present.add(k);
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

  /** 최근 windowMs 동안 기초자산 평균 — 순간 튐을 걸러낸 값. 기록이 없으면 fair(). */
  smoothedFair(symbol: string, windowMs = FUTURES_FAIR_WINDOW_MS, now = Date.now()): number | null {
    const recent = (this.history.get(symbol) ?? []).filter((point) => point.ts >= now - windowMs);
    if (recent.length === 0) return this.fair(symbol);
    return recent.reduce((sum, point) => sum + point.value, 0) / recent.length;
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
      const fair = market.smoothedFair(def.symbol);
      if (fair != null) {
        if (Date.now() - inventoryAt > POSITION_REFRESH_MS) {
          const account = await client.futuresPositions();
          inventory = account.positions.find((p) => p.symbol === def.symbol)?.qty ?? 0;
          inventoryAt = Date.now();
        }
        const center = futuresQuoteCenter(def, fair, inventory);
        const state = await client.quoteState(def.symbol);
        const step = futuresLadderStep(def, center);
        const recenter: boolean = lastCenter == null || Math.abs(center - lastCenter) >= FUTURES_RECENTER_STEPS * step;
        const effectiveCenter: number = lastCenter == null ? center : recenter ? glideCenter(lastCenter, center, step) : lastCenter;
        const diff = diffFuturesLadder(planFuturesLadder(def, effectiveCenter, step), state.orders, FUTURES_REFILL_RATIO);
        const now = Date.now();
        const liveIds = new Set(state.orders.map((order) => order.id));
        for (const id of [...cancelSentAt.keys()]) if (!liveIds.has(id)) cancelSentAt.delete(id);
        for (const order of diff.cancel) {
          if (now - (cancelSentAt.get(order.id) ?? 0) < CANCEL_RESEND_MS) continue;
          cancelSentAt.set(order.id, now);
          await client.cancelOrder(order.id).catch(() => undefined);
        }
        // 취소 중인 주문도 엔진이 처리하기 전까지는 체결될 수 있다 — 살아 있는 모든 주문과 겹치지 않게.
        for (const quote of withoutSelfCross(diff.place, state.orders)) {
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

/**
 * 가용 현금으로 열 수 있는 계약 수(0~maxQty). 시장가 신규 주문은 최근가 × 1.1 기준 위탁증거금(거래소 기준)을 묶는다.
 * 주식도 거래하는 봇(bot7 등)은 현금이 주식 재고로 빠져 있어, 이걸 안 보고 내면 422가 반복된다.
 */
export function affordableFuturesQty(def: FutureDef, lastUnits: number, available: number, maxQty: number): number {
  const perContract = Number(futureMarginPerContract(def, Math.ceil(lastUnits * MARKET_BUY_HOLD_FACTOR)));
  if (!(perContract > 0) || !(available > 0)) return 0;
  return Math.max(0, Math.min(maxQty, Math.floor(available / perContract)));
}

/** 선물 거래 흐름 봇의 주기·크기 */
export interface FuturesTraderOptions {
  /** 주문 사이 대기(ms) 최소·최대 */
  minWaitMs: number;
  maxWaitMs: number;
  /** 한 번에 1~maxQty 계약 */
  maxQty: number;
}

/** 거래가 끊기지 않게 하는 기본값 — 봇 3개가 합쳐 초당 약 1건(종목당 분당 10여 건). */
export const ACTIVE_FUTURES_TRADER: FuturesTraderOptions = { minWaitMs: 1_500, maxWaitMs: 4_000, maxQty: 5 };

/** 선물 거래 흐름: 시장가 1~maxQty 계약. 기초자산 쪽으로 되돌리는 방향을 65%로 고른다. 위험하면 줄이기만 한다. */
export async function runFuturesTrader(
  client: ApiClient,
  market: FuturesMarketView,
  name: string,
  options: FuturesTraderOptions = ACTIVE_FUTURES_TRADER,
): Promise<void> {
  const MAX_POSITION = 20;
  while (true) {
    await sleep(options.minWaitMs + Math.random() * (options.maxWaitMs - options.minWaitMs));
    try {
      const account = (await client.futuresPositions()) as FuturesAccountView;
      if (futuresRiskMode(account) === "reduce") {
        const order = reduceOrder(account.positions);
        if (order) await client.placeOrder({ ...order, type: "MARKET" });
        continue;
      }
      const def = FUTURES[Math.floor(Math.random() * FUTURES.length)];
      const fair = market.smoothedFair(def.symbol);
      const last = market.last(def.symbol);
      if (fair == null || last == null) continue;
      const position = account.positions.find((p) => p.symbol === def.symbol)?.qty ?? 0;
      let side: OrderSide = fair >= last ? "BUY" : "SELL";
      if (Math.random() > 0.65) side = side === "BUY" ? "SELL" : "BUY";
      // 한쪽으로 너무 쌓였으면 줄이는 쪽으로만.
      if (position >= MAX_POSITION) side = "SELL";
      if (position <= -MAX_POSITION) side = "BUY";
      let qty = 1 + Math.floor(Math.random() * options.maxQty);
      const closing = (side === "SELL" && position > 0) || (side === "BUY" && position < 0);
      if (!closing || qty > Math.abs(position)) {
        // 새로 여는 몫은 증거금이 필요하다 — 가용 현금 안에서만. 1계약도 못 열면 쌓인 포지션을 줄여 현금을 푼다.
        const { available } = await client.accountSummary();
        const affordable = affordableFuturesQty(def, last, available, options.maxQty);
        if (affordable < 1) {
          const order = reduceOrder(account.positions);
          if (order) await client.placeOrder({ ...order, type: "MARKET" });
          continue;
        }
        qty = closing ? Math.abs(position) : Math.min(qty, affordable);
      }
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
    await sleep(4_000 + Math.random() * 4_000);
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
        if (!side || Math.random() > 0.8) continue;
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
