"use client";

import { useEffect, useRef, useState } from "react";
import { api, fmt, won } from "@/lib/api";
import { subscribe } from "@/lib/socket";
import { kstSessionStartMs, onKstSessionOpen } from "@/lib/time";
import { everyVisible } from "@/lib/visible-interval";
import { useT } from "@/lib/i18n";

interface SessionStats {
  high: number;
  low: number;
  volume: number;
  buyVolume: number;
  sellVolume: number;
}

interface SummaryDto {
  referencePrice: number | string | null;
  sessionStart: number;
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
  /** REST 초기 기준가. 요약 응답으로 09:00 KST마다 갱신된다. */
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
 * 거래 페이지 시세 요약. 고가·저가·거래량은 09:00 KST 시작 세션의 체결 집계를 기준으로
 * 하고, 해당 스냅샷 이후의 WebSocket tick만 더해 REST/실시간 갱신의 이중 집계를 막는다.
 */
export default function QuoteHeader({ symbol, name, fallbackPrice, referencePrice }: QuoteHeaderProps) {
  const t = useT();
  const [livePrice, setLivePrice] = useState<number | null>(null);
  const [sessionReferencePrice, setSessionReferencePrice] = useState<number | null>(null);
  const [stats, setStats] = useState<SessionStats | null>(null);
  const pendingTicksRef = useRef(new Map<string, TradeTick>());
  const summaryWatermarkRef = useRef<number | null>(null);

  useEffect(() => {
    let disposed = false;
    pendingTicksRef.current.clear();
    summaryWatermarkRef.current = null;
    setLivePrice(null);
    setSessionReferencePrice(null);
    setStats(null);

    const loadSummary = () => {
      api<SummaryDto>(`/market/summary/${symbol}`, { auth: false })
        .then((summary) => {
          if (disposed) return;
          if (summary.sessionStart < kstSessionStartMs()) return;

          const watermark = finiteNumber(summary.lastTradeTs) ?? Number.NEGATIVE_INFINITY;
          const sessionStart = finiteNumber(summary.sessionStart) ?? kstSessionStartMs();
          const pendingAfterSnapshot: TradeTick[] = [];
          for (const [id, tick] of pendingTicksRef.current) {
            if (tick.ts >= sessionStart && tick.ts > watermark) pendingAfterSnapshot.push(tick);
            else pendingTicksRef.current.delete(id);
          }

          summaryWatermarkRef.current = watermark;
          setSessionReferencePrice(finiteNumber(summary.referencePrice));
          setStats(() => pendingAfterSnapshot.reduce(withTick, statsFromSummary(summary)));
        })
        .catch(() => {
          // 서버 스냅샷이 잠시 실패해도 체결 tick으로 보이는 값은 계속 갱신한다.
        });
    };

    loadSummary();
    const refreshTimer = everyVisible(loadSummary, 30_000);
    const stopSessionRefresh = onKstSessionOpen(loadSummary);
    const unsubscribe = subscribe([`trades:${symbol}`], ({ data }) => {
      const tick = parseTick(data);
      if (!tick) return;
      if (tick.ts < kstSessionStartMs()) return;

      setLivePrice(tick.price);
      pendingTicksRef.current.set(tick.id, tick);
      const watermark = summaryWatermarkRef.current;
      if (watermark == null || tick.ts > watermark) setStats((previous) => withTick(previous, tick));
    });

    return () => {
      disposed = true;
      refreshTimer();
      stopSessionRefresh();
      unsubscribe();
    };
  }, [symbol]);

  const price = livePrice ?? finiteNumber(fallbackPrice);
  const reference = sessionReferencePrice ?? finiteNumber(referencePrice);
  const change = price != null && reference != null && reference > 0 ? price - reference : null;
  const changeRate = change != null && reference != null ? (change / reference) * 100 : null;
  const tone = change == null || change === 0 ? "text-ink" : change > 0 ? "text-up" : "text-down";
  const direction = change == null || change === 0 ? t("보합") : change > 0 ? "▲" : "▼";
  const executionStrength = stats && stats.sellVolume > 0 ? (stats.buyVolume / stats.sellVolume) * 100 : null;

  return (
    // 폰(lg 미만)에서는 차트가 첫 화면에 들어오도록 카드를 줄인다: 지표는 한 줄 가로 스크롤, 설명 문구는 숨김.
    <section className="glass overflow-hidden">
      <div className="flex flex-col gap-6 p-5 max-lg:gap-3 max-lg:p-4 sm:p-6 lg:flex-row lg:items-end lg:justify-between lg:gap-10">
        <div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <h1 className="text-xl font-semibold tracking-tight">
              {name ?? symbol}
              {name && <span className="num ml-2 text-sm font-normal text-ink-faint">{symbol}</span>}
            </h1>
            <span className="chip chip-live" title={t("체결 채널을 구독해 현재가를 갱신합니다")}>
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ok" />
              LIVE
            </span>
          </div>
          <div className="num mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 max-lg:mt-1.5">
            <p className="text-3xl font-semibold tracking-tight sm:text-5xl">
              {price != null ? won(price) : "—"}
            </p>
            {change != null && changeRate != null ? (
              <p className={`text-sm font-semibold ${tone}`}>
                {direction} {change > 0 ? "+" : ""}
                {won(change)} ({changeRate > 0 ? "+" : ""}
                {changeRate.toFixed(2)}%)
              </p>
            ) : (
              <p className="text-sm text-ink-faint">{t("기준가 대비")} —</p>
            )}
          </div>
        </div>

        <dl className="num grid grid-cols-2 gap-x-6 gap-y-4 text-sm max-lg:flex max-lg:gap-x-0 max-lg:overflow-x-auto max-lg:text-[13px] max-lg:whitespace-nowrap sm:grid-cols-3 lg:grid-cols-5">
          <QuoteMetric
            label={t("기준가")}
            value={reference != null ? won(reference) : "—"}
            title={t("매일 09:00 KST 이후 첫 체결가 (첫 체결 전에는 직전 체결가)")}
          />
          <QuoteMetric
            label={t("당일 고가")}
            value={stats ? won(stats.high) : "—"}
            tone="up"
            title={t("09:00 KST부터의 체결 기준 최고가입니다")}
          />
          <QuoteMetric
            label={t("당일 저가")}
            value={stats ? won(stats.low) : "—"}
            tone="down"
            title={t("09:00 KST부터의 체결 기준 최저가입니다")}
          />
          <QuoteMetric
            label={t("당일 거래량")}
            value={stats ? t("{n}주", { n: fmt.format(stats.volume) }) : "—"}
            title={t("09:00 KST부터의 누적 체결 수량입니다")}
          />
          <QuoteMetric
            label={t("체결강도")}
            value={executionStrength != null ? `${executionStrength.toFixed(1)}%` : "—"}
            tone={executionStrength == null || executionStrength === 100 ? undefined : executionStrength > 100 ? "up" : "down"}
            title={t("09:00 KST부터의 매수 체결량 ÷ 매도 체결량입니다. 100% 초과는 매수 우위, 미만은 매도 우위입니다.")}
          />
        </dl>
      </div>
      <p className="border-t border-hairline-soft px-5 py-2 text-[11px] text-ink-faint max-lg:hidden sm:px-6">
        {t("현재가는 체결마다 갱신 · 고가/저가/거래량은 09:00 KST부터의 체결 기준")}
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
  const valueColor = tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-ink";
  return (
    <div
      title={title}
      className="min-w-24 border-l border-hairline-soft pl-4 first:border-l-0 first:pl-0 max-lg:min-w-0 max-lg:shrink-0 max-lg:pr-4 sm:border-l sm:pl-4"
    >
      <dt className="text-[11px] tracking-wide text-ink-muted uppercase">{label}</dt>
      <dd className={`mt-1 font-semibold ${valueColor}`}>{value}</dd>
    </div>
  );
}
