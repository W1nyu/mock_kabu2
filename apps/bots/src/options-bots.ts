import { ALL_OPTIONS, OPTIONS, type OptionDef, type OptionFamilyDef, type OrderSide } from "@mock-kabu/shared";
import type { ApiClient, LiveOrder } from "./client";
import { diffFuturesLadder, type FutureQuote } from "./futures-bots";

/** 옵션 호가 단수(한쪽). 종목이 많아(44) 선물보다 적게 둔다. */
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
/** 등가격에서 이 행사가 칸 수보다 멀면(먼 외가격·내가격) 호가 단수를 줄인다 — 거래가 드문 자리의 주문 수를 아낀다. */
const FAR_STRIKE_STEPS = 3.5;
const FAR_LADDER_LEVELS = 2;

export interface OptionOverviewRow {
  symbol: string;
  family: string;
  type?: "CALL" | "PUT";
  strike: number | null;
  underlying?: number | null;
  theo: number | null;
  lastPrice: number;
  tickUnits: number;
  retired?: boolean;
  expired?: boolean;
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
 * 바깥으로 1호가씩 levels단(2·3·4계약). 매수 호가는 1호가 아래로 내려가지 않는다.
 * 재고가 한도를 넘으면 더 쌓이는 쪽 호가는 내지 않는다(쓰기 증거금 폭주 방지).
 */
export function planOptionLadder(
  def: Pick<OptionDef, "tickUnits">,
  theo: number,
  inventory: number,
  /** 거래를 끝낸 옵션: 보유자가 팔 수 있게 매수 호가만 둔다(새로 쓰지 않는다) */
  bidOnly = false,
  levels: number = OPTION_LADDER_LEVELS,
): FutureQuote[] {
  const tick = def.tickUnits;
  const skewTicks = Math.max(-MAX_SKEW_TICKS, Math.min(MAX_SKEW_TICKS, Math.trunc(inventory / INVENTORY_PER_SKEW_TICK)));
  const center = roundToTick(theo, tick) - skewTicks * tick;
  const half = Math.max(tick, roundToTick((theo * HALF_SPREAD_BPS) / 10_000, tick));
  const quotes: FutureQuote[] = [];
  for (let level = 1; level <= levels; level++) {
    const qty = level + 1;
    const bid = center - half - (level - 1) * tick;
    if (bid >= tick && inventory < OPTION_MM_MAX_INVENTORY) quotes.push({ side: "BUY", price: bid, qty });
    if (!bidOnly && inventory > -OPTION_MM_MAX_INVENTORY) quotes.push({ side: "SELL", price: Math.max(center + half, tick * 2) + (level - 1) * tick, qty });
  }
  return quotes;
}

/** 등가격에서 몇 행사가 칸 떨어졌는지(행사가 간격 단위) */
export function strikeSteps(row: Pick<OptionOverviewRow, "strike" | "underlying">, family: Pick<OptionFamilyDef, "strikeStepUnits">): number {
  if (row.strike == null || row.underlying == null) return 0;
  return Math.abs(row.strike - row.underlying) / family.strikeStepUnits;
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

  all(): OptionOverviewRow[] {
    return [...this.rows.values()];
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 옵션 한 기초자산(콜·풋 × 행사가 11개) 전담 마켓메이커(bot43 원자재지수, bot42 원/달러).
 * 거래를 끝낸 계열(bot41 주가지수)은 만기까지 매수 호가만 두고, 만기가 지나면 남은 주문을 모두 거둔다.
 * 살아 있는 주문은 루프마다 한 번에 읽는다(종목마다 요청하지 않는다).
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
      const live = await client.liveOrdersAll();
      const liveBySymbol = new Map<string, LiveOrder[]>();
      for (const order of live) liveBySymbol.set(order.symbol, [...(liveBySymbol.get(order.symbol) ?? []), order]);
      const liveIds = new Set(live.map((order) => order.id));
      const now = Date.now();
      for (const [id, at] of cancelSentAt) if (!liveIds.has(id) && now - at > CANCEL_RESEND_MS) cancelSentAt.delete(id);

      for (const def of defs) {
        const row = market.row(def.symbol);
        const orders = liveBySymbol.get(def.symbol) ?? [];
        let desired: FutureQuote[] = [];
        if (row && !row.expired && row.theo != null && row.strike != null) {
          const previous = lastTheo.get(def.symbol);
          const theo = previous != null && Math.abs(row.theo - previous) <= def.tickUnits ? previous : row.theo;
          const levels = strikeSteps(row, family) > FAR_STRIKE_STEPS ? FAR_LADDER_LEVELS : OPTION_LADDER_LEVELS;
          desired = planOptionLadder(def, theo, inventory.get(def.symbol) ?? 0, bidOnly, levels);
          lastTheo.set(def.symbol, theo);
        } else if (!row?.expired) {
          continue; // 시세가 아직 없으면 기존 호가를 건드리지 않는다
        }
        const diff = diffFuturesLadder(desired, orders);
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
      }
    } catch (error) {
      console.warn(`[options-mm:${family.code}]`, error instanceof Error ? error.message : error);
    }
    await sleep(MM_LOOP_MS);
  }
}

/**
 * 등가격에서 몇 칸 떨어진 행사가를 살지 — 가까울수록 자주:
 * 0칸 30%, ±1칸 각 15%, ±2칸 각 10%, ±3칸 각 5%, ±4·±5칸 각 2.5%.
 */
export function pickStrikeOffset(rand: () => number = Math.random): number {
  const r = rand();
  const table: [number, number][] = [
    [0.3, 0], [0.45, -1], [0.6, 1], [0.7, -2], [0.8, 2], [0.85, -3], [0.9, 3], [0.925, -4], [0.95, 4], [0.975, -5],
  ];
  for (const [limit, offset] of table) if (r < limit) return offset;
  return 5;
}

/** 계열의 거래 중인 옵션에서 등가격 + offset 칸 행사가의 콜/풋 하나 */
export function pickOptionByOffset(
  rows: readonly OptionOverviewRow[],
  offset: number,
  type: "CALL" | "PUT",
): OptionOverviewRow | null {
  const live = rows.filter((row) => !row.retired && row.strike != null && row.theo != null);
  const strikes = [...new Set(live.map((row) => row.strike!))].sort((a, b) => a - b);
  const underlying = live[0]?.underlying;
  if (strikes.length === 0 || underlying == null) return null;
  let atm = 0;
  for (let index = 1; index < strikes.length; index++) {
    if (Math.abs(strikes[index] - underlying) < Math.abs(strikes[atm] - underlying)) atm = index;
  }
  const strike = strikes[Math.max(0, Math.min(strikes.length - 1, atm + offset))];
  return live.find((row) => row.strike === strike && row.type === type) ?? null;
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
      const families = [...new Set(OPTIONS.map((def) => def.family.code))];
      const familyCode = families[Math.floor(Math.random() * families.length)];
      const rows = market.all().filter((row) => row.family === familyCode);
      const pick = pickOptionByOffset(rows, pickStrikeOffset(), Math.random() < 0.5 ? "CALL" : "PUT");
      if (!pick) continue;
      await client.placeOrder({ symbol: pick.symbol, side: "BUY", type: "MARKET", qty: 1 + Math.floor(Math.random() * 3) });
    } catch (error) {
      console.warn(`[options:${name}]`, error instanceof Error ? error.message : error);
    }
  }
}
