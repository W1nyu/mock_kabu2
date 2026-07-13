"use client";

import { useEffect, useRef, useState } from "react";
import { api, fmt } from "@/lib/api";
import { subscribe } from "@/lib/socket";

interface SessionStats {
  high: number;
  low: number;
  volume: number;
  buyVolume: number;
  sellVolume: number;
}

interface SummaryDto {
  high: number | string | null;
  low: number | string | null;
  volume: number | string | null;
  buyVolume: number | string | null;
  sellVolume: number | string | null;
  lastTradeTs: number | string | null;
}

interface TradeTick {
  id: string;
  price: number;
  qty: number;
  takerSide: "BUY" | "SELL";
  ts: number;
}

interface QuoteHeaderProps {
  symbol: string;
  name?: string;
  /** REST 초기값. 체결이 들어오면 실시간 가격이 우선된다. */
  fallbackPrice: number | null;
  /** 현재 모의 시장의 시드/기준 가격. */
  referencePrice: number | null;
}

function finiteNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function statsFromSummary(summary: SummaryDto): SessionStats | null {
  const high = finiteNumber(summary.high);
  const low = finiteNumber(summary.low);
  const volume = finiteNumber(summary.volume);
  const buyVolume = Math.max(0, finiteNumber(summary.buyVolume) ?? 0);
  const sellVolume = Math.max(0, finiteNumber(summary.sellVolume) ?? 0);
  return high != null && low != null
    ? { high, low, volume: Math.max(0, volume ?? 0), buyVolume, sellVolume }
    : null;
}

function withTick(previous: SessionStats | null, tick: TradeTick): SessionStats {
  return previous
    ? {
        high: Math.max(previous.high, tick.price),
        low: Math.min(previous.low, tick.price),
        volume: previous.volume + tick.qty,
        buyVolume: previous.buyVolume + (tick.takerSide === "BUY" ? tick.qty : 0),
        sellVolume: previous.sellVolume + (tick.takerSide === "SELL" ? tick.qty : 0),
      }
    : {
        high: tick.price,
        low: tick.price,
        volume: tick.qty,
        buyVolume: tick.takerSide === "BUY" ? tick.qty : 0,
        sellVolume: tick.takerSide === "SELL" ? tick.qty : 0,
      };
}

function parseTick(data: any): TradeTick | null {
  const price = finiteNumber(data?.price);
  const ts = finiteNumber(data?.ts);
  if (price == null || ts == null) return null;
  const qty = Math.max(0, finiteNumber(data?.qty) ?? 0);
  const takerSide = data?.takerSide === "BUY" || data?.takerSide === "SELL" ? data.takerSide : null;
  if (takerSide == null) return null;
  const id = typeof data?.tradeId === "string" ? data.tradeId : `${ts}:${price}:${qty}`;
  return { id, price, qty, takerSide, ts };
}

/**
 * 거래 페이지 시세 요약. 당일 고가·저가·거래량은 서버의 KST 당일 체결 집계를 기준으로
 * 하고, 해당 스냅샷 이후의 WebSocket tick만 더해 REST/실시간 갱신의 이중 집계를 막는다.
 */
export default function QuoteHeader({ symbol, name, fallbackPrice, referencePrice }: QuoteHeaderProps) {
  const [livePrice, setLivePrice] = useState<number | null>(null);
  const [stats, setStats] = useState<SessionStats | null>(null);
  const pendingTicksRef = useRef(new Map<string, TradeTick>());
  const summaryWatermarkRef = useRef<number | null>(null);

  useEffect(() => {
    let disposed = false;
    pendingTicksRef.current.clear();
    summaryWatermarkRef.current = null;
    setLivePrice(null);
    setStats(null);

    const loadSummary = () => {
      api<SummaryDto>(`/market/summary/${symbol}`, { auth: false })
        .then((summary) => {
          if (disposed) return;

          const watermark = finiteNumber(summary.lastTradeTs) ?? Number.NEGATIVE_INFINITY;
          const pendingAfterSnapshot: TradeTick[] = [];
          for (const [id, tick] of pendingTicksRef.current) {
            if (tick.ts > watermark) pendingAfterSnapshot.push(tick);
            else pendingTicksRef.current.delete(id);
          }

          summaryWatermarkRef.current = watermark;
          setStats(() => pendingAfterSnapshot.reduce(withTick, statsFromSummary(summary)));
        })
        .catch(() => {
          // 서버 스냅샷이 잠시 실패해도 체결 tick으로 보이는 값은 계속 갱신한다.
        });
    };

    loadSummary();
    const refreshTimer = window.setInterval(loadSummary, 30_000);
    const unsubscribe = subscribe([`trades:${symbol}`], ({ data }) => {
      const tick = parseTick(data);
      if (!tick) return;

      setLivePrice(tick.price);
      pendingTicksRef.current.set(tick.id, tick);
      const watermark = summaryWatermarkRef.current;
      if (watermark == null || tick.ts > watermark) setStats((previous) => withTick(previous, tick));
    });

    return () => {
      disposed = true;
      window.clearInterval(refreshTimer);
      unsubscribe();
    };
  }, [symbol]);

  const price = livePrice ?? finiteNumber(fallbackPrice);
  const reference = finiteNumber(referencePrice);
  const change = price != null && reference != null && reference > 0 ? price - reference : null;
  const changeRate = change != null && reference != null ? (change / reference) * 100 : null;
  const tone = change == null || change === 0 ? "text-neutral-200" : change > 0 ? "text-red-400" : "text-blue-400";
  const direction = change == null || change === 0 ? "보합" : change > 0 ? "▲" : "▼";
  const executionStrength = stats && stats.sellVolume > 0 ? (stats.buyVolume / stats.sellVolume) * 100 : null;

  return (
    <section className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900 shadow-sm">
      <div className="flex flex-col gap-5 px-4 py-4 sm:px-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="text-xl font-bold tracking-tight">
              {symbol} {name && <span className="text-base font-normal text-neutral-400">{name}</span>}
            </h1>
            <span
              title="체결 채널을 구독해 현재가를 갱신합니다"
              className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-400"
            >
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
              LIVE
            </span>
          </div>
          <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 tabular-nums">
            <p className="text-3xl font-bold tracking-tight text-neutral-50 sm:text-4xl">
              {price != null ? `${fmt.format(price)}원` : "—"}
            </p>
            {change != null && changeRate != null ? (
              <p className={`text-sm font-semibold ${tone}`}>
                {direction} {change > 0 ? "+" : ""}
                {fmt.format(change)}원 ({changeRate > 0 ? "+" : ""}
                {changeRate.toFixed(2)}%)
              </p>
            ) : (
              <p className="text-sm text-neutral-500">기준가 대비 —</p>
            )}
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-x-5 gap-y-3 text-sm tabular-nums sm:grid-cols-5">
          <QuoteMetric
            label="기준가"
            value={reference != null ? `${fmt.format(reference)}원` : "—"}
            title="현재 모의 시장의 시드·기준 가격입니다"
          />
          <QuoteMetric
            label="당일 고가"
            value={stats ? `${fmt.format(stats.high)}원` : "—"}
            tone="up"
            title="KST 당일 체결 기준 최고가입니다"
          />
          <QuoteMetric
            label="당일 저가"
            value={stats ? `${fmt.format(stats.low)}원` : "—"}
            tone="down"
            title="KST 당일 체결 기준 최저가입니다"
          />
          <QuoteMetric
            label="당일 거래량"
            value={stats ? `${fmt.format(stats.volume)}주` : "—"}
            title="KST 당일 누적 체결 수량입니다"
          />
          <QuoteMetric
            label="체결강도"
            value={executionStrength != null ? `${executionStrength.toFixed(1)}%` : "—"}
            tone={executionStrength == null || executionStrength === 100 ? undefined : executionStrength > 100 ? "up" : "down"}
            title="KST 당일 매수 체결량 ÷ 매도 체결량입니다. 100% 초과는 매수 우위, 미만은 매도 우위입니다."
          />
        </dl>
      </div>
      <p className="border-t border-neutral-800 px-4 py-1.5 text-[11px] text-neutral-500 sm:px-5">
        현재가는 체결마다 갱신 · 고가/저가/거래량은 KST 당일 체결 기준
      </p>
    </section>
  );
}

function QuoteMetric({
  label,
  value,
  tone,
  title,
}: {
  label: string;
  value: string;
  tone?: "up" | "down";
  title: string;
}) {
  const valueColor = tone === "up" ? "text-red-400" : tone === "down" ? "text-blue-400" : "text-neutral-100";
  return (
    <div title={title} className="min-w-24 border-l border-neutral-800 pl-3 first:border-l-0 first:pl-0">
      <dt className="text-[11px] text-neutral-500">{label}</dt>
      <dd className={`mt-0.5 font-semibold ${valueColor}`}>{value}</dd>
    </div>
  );
}
