import { ALL_OPTIONS, OPTIONS, type OptionDef, type OptionFamilyDef, type OrderSide } from "@mock-kabu/shared";
import type { ApiClient } from "./client";
import { diffFuturesLadder, type FutureQuote } from "./futures-bots";

/** 옵션 호가 단수(한쪽). 20종목이라 선물보다 적게 둔다. */
export const OPTION_LADDER_LEVELS = 3;
/** 스프레드(한쪽) = 이론가의 이 비율(bps), 최소 1호가 */
const HALF_SPREAD_BPS = 400;
/** 재고 10계약마다 중심을 1호가 반대로(최대 3호가). 이 계약 수를 넘으면 쌓는 쪽 호가를 내지 않는다. */
const INVENTORY_PER_SKEW_TICK = 10;
const MAX_SKEW_TICKS = 3;
export const OPTION_MM_MAX_INVENTORY = 40;

const MM_LOOP_MS = 4_000;
const POSITION_REFRESH_MS = 10_000;
const OVERVIEW_REFRESH_MS = 2_000;
const CANCEL_RESEND_MS = 30_000;

export interface OptionOverviewRow {
  symbol: string;
  family: string;
  strike: number | null;
  theo: number | null;
  lastPrice: number;
  tickUnits: number;
}

export interface OptionPositionView {
  symbol: string;
  qty: number;
}

function roundToTick(value: number, tick: number): number {
  return Math.max(tick, Math.round(value / tick) * tick);
}

/**
 * 이론가·재고로 호가를 짠다. 중심 = 이론가 − 재고 기울기, 한쪽 스프레드 = max(1호가, 이론가 × 4%),
 * 바깥으로 1호가씩 3단(2·3·4계약). 매수 호가는 1호가 아래로 내려가지 않는다.
 * 재고가 한도를 넘으면 더 쌓이는 쪽 호가는 내지 않는다(쓰기 증거금 폭주 방지).
 */
export function planOptionLadder(
  def: Pick<OptionDef, "tickUnits">,
  theo: number,
  inventory: number,
  /** 거래를 끝낸 옵션: 보유자가 팔 수 있게 매수 호가만 둔다(새로 쓰지 않는다) */
  bidOnly = false,
): FutureQuote[] {
  const tick = def.tickUnits;
  const skewTicks = Math.max(-MAX_SKEW_TICKS, Math.min(MAX_SKEW_TICKS, Math.trunc(inventory / INVENTORY_PER_SKEW_TICK)));
  const center = roundToTick(theo, tick) - skewTicks * tick;
  const half = Math.max(tick, roundToTick((theo * HALF_SPREAD_BPS) / 10_000, tick));
  const quotes: FutureQuote[] = [];
  for (let level = 1; level <= OPTION_LADDER_LEVELS; level++) {
    const qty = level + 1;
    const bid = center - half - (level - 1) * tick;
    if (bid >= tick && inventory < OPTION_MM_MAX_INVENTORY) quotes.push({ side: "BUY", price: bid, qty });
    if (!bidOnly && inventory > -OPTION_MM_MAX_INVENTORY) quotes.push({ side: "SELL", price: Math.max(center + half, tick * 2) + (level - 1) * tick, qty });
  }
  return quotes;
}

/** 봇 프로세스 안에서 옵션 시세(행사가·이론가)를 한 번만 읽어 나눠 쓴다(API도 2초 캐시). */
export class OptionsMarketView {
  private rows = new Map<string, OptionOverviewRow>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly client: ApiClient) {}

  start(): void {
    const load = () =>
      this.client
        .optionsOverview()
        .then((rows) => {
          this.rows = new Map(rows.map((row) => [row.symbol, row]));
        })
        .catch((error) => console.warn("[options] overview failed", error instanceof Error ? error.message : error));
    void load();
    this.timer = setInterval(load, OVERVIEW_REFRESH_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  row(symbol: string): OptionOverviewRow | null {
    return this.rows.get(symbol) ?? null;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 옵션 한 기초자산(콜·풋 × 행사가 5개) 전담 마켓메이커(bot43 원자재지수, bot42 원/달러).
 * 거래를 끝낸 계열(bot41 주가지수)은 만기까지 매수 호가만 둔다.
 */
export async function runOptionsMarketMaker(client: ApiClient, family: OptionFamilyDef, market: OptionsMarketView): Promise<void> {
  const defs = ALL_OPTIONS.filter((def) => def.family.code === family.code);
  const bidOnly = family.retired === true;
  let inventory = new Map<string, number>();
  let inventoryAt = 0;
  // 이론가가 1호가 넘게 움직일 때만 호가를 옮긴다. 그 사이에는 빈 칸만 채운다.
  const lastTheo = new Map<string, number>();
  const cancelSentAt = new Map<string, number>();
  while (true) {
    try {
      if (Date.now() - inventoryAt > POSITION_REFRESH_MS) {
        const account = await client.optionsPositions();
        inventory = new Map(account.map((p) => [p.symbol, p.qty]));
        inventoryAt = Date.now();
      }
      for (const def of defs) {
        const row = market.row(def.symbol);
        if (row?.theo == null || row.strike == null) continue;
        const previous = lastTheo.get(def.symbol);
        const theo = previous != null && Math.abs(row.theo - previous) <= def.tickUnits ? previous : row.theo;
        const state = await client.quoteState(def.symbol);
        const diff = diffFuturesLadder(planOptionLadder(def, theo, inventory.get(def.symbol) ?? 0, bidOnly), state.orders);
        const now = Date.now();
        const liveIds = new Set(state.orders.map((order) => order.id));
        for (const [id] of cancelSentAt) if (!liveIds.has(id) && now - (cancelSentAt.get(id) ?? 0) > CANCEL_RESEND_MS) cancelSentAt.delete(id);
        for (const order of diff.cancel) {
          if (now - (cancelSentAt.get(order.id) ?? 0) < CANCEL_RESEND_MS) continue;
          cancelSentAt.set(order.id, now);
          await client.cancelOrder(order.id).catch(() => undefined);
        }
        for (const quote of diff.place) {
          await client
            .placeOrder({ symbol: def.symbol, side: quote.side, type: "LIMIT", price: quote.price, qty: quote.qty })
            .catch((error) => console.warn(`[options-mm:${def.symbol}] place failed`, error instanceof Error ? error.message : error));
        }
        lastTheo.set(def.symbol, theo);
      }
    } catch (error) {
      console.warn(`[options-mm:${family.code}]`, error instanceof Error ? error.message : error);
    }
    await sleep(MM_LOOP_MS);
  }
}

/** 등가격(3번)에 가까울수록 자주 고른다: 3번 40%, 2·4번 각 20%, 1·5번 각 10%. */
export function pickOptionSlot(rand: () => number = Math.random): number {
  const r = rand();
  if (r < 0.4) return 3;
  if (r < 0.6) return 2;
  if (r < 0.8) return 4;
  if (r < 0.9) return 1;
  return 5;
}

/**
 * 옵션 거래 흐름(사용자처럼 매수 → 몇 분 뒤 청산 매도만). 20~50초마다:
 * 보유 기간이 끝난 옵션이 있으면 보유 수량 전부 시장가 매도, 아니면 보유 종목이 3개 미만일 때 1~3계약 시장가 매수.
 * 보유 수량보다 많이 팔지 않는다(봇 계정은 쓰기가 허용되므로 여기서 막는다).
 */
export async function runOptionsTrader(client: ApiClient, market: OptionsMarketView, name: string): Promise<void> {
  const MAX_HELD = 3;
  const exitAt = new Map<string, number>();
  while (true) {
    await sleep(20_000 + Math.random() * 30_000);
    try {
      const positions = (await client.optionsPositions()).filter((p) => p.qty > 0);
      const now = Date.now();
      for (const p of positions) if (!exitAt.has(p.symbol)) exitAt.set(p.symbol, now + 2 * 60_000 + Math.random() * 6 * 60_000);
      for (const symbol of [...exitAt.keys()]) if (!positions.some((p) => p.symbol === symbol)) exitAt.delete(symbol);

      const due = positions.find((p) => (exitAt.get(p.symbol) ?? Infinity) <= now);
      if (due) {
        await client.placeOrder({ symbol: due.symbol, side: "SELL" as OrderSide, type: "MARKET", qty: due.qty });
        exitAt.delete(due.symbol);
        continue;
      }
      if (positions.length >= MAX_HELD) continue;
      const slot = pickOptionSlot();
      const candidates = OPTIONS.filter((def) => def.slot === slot);
      const def = candidates[Math.floor(Math.random() * candidates.length)];
      if (market.row(def.symbol)?.theo == null) continue;
      await client.placeOrder({ symbol: def.symbol, side: "BUY", type: "MARKET", qty: 1 + Math.floor(Math.random() * 3) });
    } catch (error) {
      console.warn(`[options:${name}]`, error instanceof Error ? error.message : error);
    }
  }
}
