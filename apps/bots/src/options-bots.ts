import { ALL_OPTIONS, OPTIONS, type OptionDef, type OptionFamilyDef, type OrderSide } from "@mock-kabu/shared";
import type { ApiClient, LiveOrder } from "./client";
import { diffFuturesLadder, type FutureQuote } from "./futures-bots";

/** 옵션 호가 단수(한쪽). 종목이 많아(44) 선물보다 적게 둔다. */
export const OPTION_LADDER_LEVELS = 3;
/** 스프레드(한쪽) = 이론가의 이 비율(bps), 최소 1호가·최대 MAX_HALF_SPREAD_TICKS호가 */
const HALF_SPREAD_BPS = 400;
/** 깊은 내가격(이론가 수십 pt)은 4%면 수십 호가라 체결가가 이론가에서 크게 벗어난다 — 한쪽 10호가로 묶는다. */
const MAX_HALF_SPREAD_TICKS = 10;
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

/** 마켓메이커 한쪽 스프레드 = 이론가 × 4%, 1~10호가 */
export function optionHalfSpread(tick: number, theo: number): number {
  return Math.min(tick * MAX_HALF_SPREAD_TICKS, Math.max(tick, roundToTick((theo * HALF_SPREAD_BPS) / 10_000, tick)));
}

/**
 * 이론가·재고로 호가를 짠다. 중심 = 이론가 − 재고 기울기, 한쪽 스프레드 = 이론가 × 4%(1~10호가),
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
  const half = optionHalfSpread(tick, theo);
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
 * 옵션 한 기초자산(콜·풋 × 행사가 21·11개) 전담 마켓메이커(bot41 주가지수, bot42 원/달러).
 * 거래를 끝낸 계열(bot43 원자재지수)은 만기까지 매수 호가만 두고, 만기가 지나면 남은 주문을 모두 거둔다.
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
 * 최근 체결가가 이론가에서 가장 멀리 벗어난 옵션 — 마켓메이커 스프레드 + 2호가보다 멀면 "오래된 가격"으로 본다.
 * 등가격 근처만 고르는 흐름(pickStrikeOffset, ±5칸)으로는 깊은 내가격·먼 행사가가 몇십 분씩 체결이 없어
 * 기초자산이 움직인 만큼 최근가가 이론가와 벌어진다(2026-09-29 주가지수 콜 1,050~1,120).
 * 이론가 2호가 미만(가치 거의 0)은 제외한다. 없으면 null.
 */
export function pickStaleOption(
  rows: readonly OptionOverviewRow[],
  exclude: ReadonlySet<string> = new Set(),
): OptionOverviewRow | null {
  let best: OptionOverviewRow | null = null;
  let bestScore = 1;
  for (const row of rows) {
    if (row.retired || row.expired || row.theo == null || row.strike == null || exclude.has(row.symbol)) continue;
    if (row.theo < row.tickUnits * 2) continue;
    const allowed = optionHalfSpread(row.tickUnits, row.theo) + row.tickUnits * 2;
    const score = Math.abs(row.lastPrice - row.theo) / allowed;
    if (score > bestScore) {
      best = row;
      bestScore = score;
    }
  }
  return best;
}

/** 새로 열 때 오래된 가격의 옵션(pickStaleOption)을 먼저 고르는 비율 */
export const STALE_PICK_RATIO = 0.5;

/** 옵션 거래 흐름 한 계정의 성격 */
export interface OptionsTraderStyle {
  /** 한 번 쉬는 시간(ms) [최소, 최대] */
  pauseMs: [number, number];
  /** 동시에 들고 있는 종목 수 상한 */
  maxHeld: number;
  /** 새로 열 때 매도(쓰기)로 여는 비율 — 봇 계정만 쓰기가 허용된다 */
  writeRatio: number;
}

export const OPTIONS_TRADER_STYLES: Record<string, OptionsTraderStyle> = {
  // 매수 위주 개인 투자자 흐름
  buyer: { pauseMs: [8_000, 20_000], maxHeld: 6, writeRatio: 0.15 },
  // 외가격을 파는(쓰는) 프리미엄 수취 흐름 — 매수 흐름의 상대편
  writer: { pauseMs: [10_000, 25_000], maxHeld: 6, writeRatio: 0.7 },
};

/** 보유 포지션을 닫는 주문 — 매수 보유는 매도, 쓴(매도) 포지션은 되사기. 보유가 없으면 null. */
export function closingOrder(position: { symbol: string; qty: number }): { symbol: string; side: OrderSide; qty: number } | null {
  if (position.qty === 0) return null;
  return { symbol: position.symbol, side: position.qty > 0 ? "SELL" : "BUY", qty: Math.abs(position.qty) };
}

/**
 * 만기까지 그냥 두는 매수 보유분 — 이론가가 2호가 미만이면 마켓메이커가 매수 호가를 내지 않아(planOptionLadder) 팔 곳이 없다.
 * 이런 보유분을 계속 닫으려 하면 보유 한도(`maxHeld`)를 채운 채 흐름 전체가 멈춘다(2026-09-27 12~18시 체결 0).
 */
export function heldToExpiry(position: { qty: number }, row: Pick<OptionOverviewRow, "theo" | "tickUnits"> | null): boolean {
  return position.qty > 0 && row?.theo != null && row.theo < row.tickUnits * 2;
}

/**
 * 옵션 거래 흐름(사용자처럼 열고 → 1~6분 뒤 청산). `pauseMs`마다:
 * 보유 기간이 끝난 포지션이 있으면 전부 시장가로 닫고, 아니면 보유 종목이 `maxHeld` 미만일 때 1~3계약을 연다 —
 * `writeRatio` 확률로 매도(쓰기, 등가격 근처·외가격), 나머지는 매수. 절반은 최근가가 이론가에서 벗어난 옵션(pickStaleOption)을
 * 먼저 거래해 행사가 전체의 최근가가 이론가를 따라가게 한다. 닫을 때 보유 수량보다 많이 거래하지 않는다.
 * 호가가 없어 닫지 못하면 1분 뒤 다시 시도한다. 가치가 거의 0인 매수 보유분(heldToExpiry)은 닫지 않고 보유 한도에서도 뺀다.
 */
export async function runOptionsTrader(
  client: ApiClient,
  market: OptionsMarketView,
  name: string,
  style: OptionsTraderStyle = OPTIONS_TRADER_STYLES.buyer,
): Promise<void> {
  const exitAt = new Map<string, number>();
  const [pauseMin, pauseMax] = style.pauseMs;
  while (true) {
    await sleep(pauseMin + Math.random() * (pauseMax - pauseMin));
    try {
      const positions = (await client.optionsPositions()).filter((p) => p.qty !== 0);
      const active = positions.filter((p) => !heldToExpiry(p, market.row(p.symbol)));
      const now = Date.now();
      for (const p of active) if (!exitAt.has(p.symbol)) exitAt.set(p.symbol, now + 60_000 + Math.random() * 5 * 60_000);
      for (const symbol of [...exitAt.keys()]) if (!active.some((p) => p.symbol === symbol)) exitAt.delete(symbol);

      const due = active.find((p) => (exitAt.get(p.symbol) ?? Infinity) <= now);
      if (due) {
        const order = closingOrder(due)!;
        exitAt.set(due.symbol, now + 60_000); // 실패하면 1분 뒤 다시
        await client.placeOrder({ ...order, type: "MARKET" });
        exitAt.delete(due.symbol);
        continue;
      }
      if (active.length >= style.maxHeld) continue;
      const families = [...new Set(OPTIONS.map((def) => def.family.code))];
      const familyCode = families[Math.floor(Math.random() * families.length)];
      const rows = market.all().filter((row) => row.family === familyCode && !row.expired);
      const write = Math.random() < style.writeRatio;
      const held = new Set(positions.map((p) => p.symbol));
      const stale = Math.random() < STALE_PICK_RATIO ? pickStaleOption(rows, held) : null;
      if (stale) {
        await client.placeOrder({ symbol: stale.symbol, side: write ? "SELL" : "BUY", type: "MARKET", qty: 1 + Math.floor(Math.random() * 2) });
        continue;
      }
      const type = Math.random() < 0.5 ? "CALL" : "PUT";
      // 쓰기는 외가격 쪽(콜은 위, 풋은 아래)으로 0~3칸 — 내가격을 쓰면 만기 손실이 커 실제 흐름과 다르다.
      const offset = write
        ? (type === "CALL" ? 1 : -1) * Math.floor(Math.random() * 4)
        : pickStrikeOffset();
      const pick = pickOptionByOffset(rows, offset, type);
      if (!pick || positions.some((p) => p.symbol === pick.symbol)) continue;
      await client.placeOrder({
        symbol: pick.symbol,
        side: write ? "SELL" : "BUY",
        type: "MARKET",
        qty: 1 + Math.floor(Math.random() * 3),
      });
    } catch (error) {
      console.warn(`[options:${name}]`, error instanceof Error ? error.message : error);
    }
  }
}
