"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AreaSeries,
  ColorType,
  createChart,
  type MouseEventParams,
  TickMarkType,
  type UTCTimestamp,
} from "lightweight-charts";
import { api, fmt } from "@/lib/api";
import { subscribe } from "@/lib/socket";
import { formatKstHm, formatKstMonthDay, formatKstTime, kstSessionStartMs, onKstSessionOpen } from "@/lib/time";
import { indexSessionBase, type IndexPoint } from "@/lib/index-session";
import { liveIndexLevel, type IndexMeta } from "@/lib/index-meta";
import { chartTheme, useTheme } from "@/lib/theme";
import { everyVisible } from "@/lib/visible-interval";
import { useNames, useT } from "@/lib/i18n";

interface SymbolRow {
  symbol: string;
  name: string;
  lastPrice: number;
  initialPrice: number;
  referencePrice: number;
  sessionStart: number;
}

type Range = "1d" | "1w" | "all";

const RANGES: { id: Range; label: string; hint: string }[] = [
  { id: "1d", label: "1일", hint: "최근 24시간, 1분 간격" },
  { id: "1w", label: "1주", hint: "최근 7일, 10분 간격" },
  { id: "all", label: "전체", hint: "상장 이후, 1시간 간격" },
];

const REFRESH_MS = 30_000;
const RANGE_STORAGE_KEY = "mock-kabu2:index-range";

const indexFormatter = new Intl.NumberFormat("ko-KR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function tickMark(time: UTCTimestamp, type: TickMarkType): string {
  const ms = time * 1000;
  switch (type) {
    case TickMarkType.Year:
    case TickMarkType.Month:
    case TickMarkType.DayOfMonth:
      return formatKstMonthDay(ms);
    case TickMarkType.TimeWithSeconds:
      return formatKstTime(ms);
    default:
      return formatKstHm(ms);
  }
}

function toneOf(delta: number): string {
  return delta > 0 ? "text-up" : delta < 0 ? "text-down" : "text-ink-muted";
}

function signed(value: number, digits = 2): string {
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;
}

/**
 * 시장 지수 창. 서버의 `/market/index`(봉 기반, 캐시)로 추이를 그리고, 현재 값은
 * 종목별 체결 push로 실시간 재계산한다(현재가 ÷ 시초가의 평균 × 1,000 — 서버와 같은 식).
 * 지수는 상장 기준값을 유지하고, 종목별 등락률은 09:00 KST 기준가를 사용한다.
 */
export default function MarketIndexPanel() {
  const tr = useT();
  const names = useNames();
  const theme = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState<Range>("1d");
  const [series, setSeries] = useState<IndexPoint[] | null>(null);
  const [rows, setRows] = useState<SymbolRow[]>([]);
  const [meta, setMeta] = useState<IndexMeta | null>(null);
  const [live, setLive] = useState<Record<string, number>>({});
  const [hover, setHover] = useState<IndexPoint | null>(null);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(RANGE_STORAGE_KEY);
      if (saved === "1d" || saved === "1w" || saved === "all") setRange(saved);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    let active = true;
    const load = () => {
      api<IndexPoint[]>(`/market/index?range=${range}`, { auth: false })
        .then((points) => {
          if (active) setSeries(points);
        })
        .catch(() => {});
      api<SymbolRow[]>("/market/symbols", { auth: false })
        .then((data) => {
          if (active && data.every((row) => row.sessionStart >= kstSessionStartMs())) setRows(data);
        })
        .catch(() => {});
      api<IndexMeta>("/market/index/meta", { auth: false })
        .then((data) => {
          if (active) setMeta(data);
        })
        .catch(() => {});
    };
    load();
    const t = everyVisible(load, REFRESH_MS);
    const stopSessionRefresh = onKstSessionOpen(load);
    return () => {
      active = false;
      t();
      stopSessionRefresh();
    };
  }, [range]);

  useEffect(() => {
    if (rows.length === 0) return;
    return subscribe(
      rows.map((r) => `trades:${r.symbol}`),
      ({ channel, data }) => {
        const price = Number(data?.price);
        if (!Number.isFinite(price)) return;
        const symbol = channel.slice("trades:".length);
        setLive((prev) => (prev[symbol] === price ? prev : { ...prev, [symbol]: price }));
      },
    );
  }, [rows]);

  // 현재 지수 — Σ(현재가 × 발행주식수) ÷ 제수. 서버 지수와 같은 정의라 차트 마지막 점과 이어진다.
  const current = useMemo(() => {
    if (!meta || rows.length === 0) return null;
    const bySymbol = new Map(rows.map((r) => [r.symbol, r]));
    return liveIndexLevel(meta, (symbol) => live[symbol] ?? bySymbol.get(symbol)?.lastPrice);
  }, [meta, rows, live]);

  const first = series && series.length > 0 ? series[0] : null;
  const shown = hover ?? (current != null ? { ts: Date.now(), value: current } : null);
  const sessionBase = shown && series ? indexSessionBase(series, shown.ts) : null;
  const baseDelta = shown && sessionBase != null ? shown.value - sessionBase : null;
  const baseRate = baseDelta != null && sessionBase && sessionBase > 0 ? (baseDelta / sessionBase) * 100 : null;
  const comparisonBase = range === "1d" ? sessionBase : first?.value;
  const rangeDelta = shown && comparisonBase != null ? shown.value - comparisonBase : null;
  const rangeRate = rangeDelta != null && comparisonBase && comparisonBase > 0 ? (rangeDelta / comparisonBase) * 100 : null;
  const rangeLabel = tr(range === "1d" ? "오늘" : RANGES.find((r) => r.id === range)?.label ?? "");

  useEffect(() => {
    if (!containerRef.current || !series || series.length === 0) return;
    const firstValue = series[0].value;
    const lastValue = current ?? series[series.length - 1].value;
    const colors = chartTheme();
    const reference = range === "1d" ? (indexSessionBase(series, Date.now()) ?? firstValue) : firstValue;
    const tone = lastValue > reference ? colors.up : lastValue < reference ? colors.down : colors.sky;
    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: colors.text,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: colors.grid },
        horzLines: { color: colors.grid },
      },
      localization: {
        timeFormatter: (time: UTCTimestamp) =>
          `${formatKstMonthDay(time * 1000)} ${formatKstHm(time * 1000)}`,
        priceFormatter: (price: number) => indexFormatter.format(price),
      },
      timeScale: {
        timeVisible: range !== "all",
        secondsVisible: false,
        borderColor: colors.border,
        tickMarkFormatter: tickMark,
      },
      rightPriceScale: {
        borderColor: colors.border,
        scaleMargins: { top: 0.12, bottom: 0.08 },
      },
      crosshair: { mode: 0 },
      handleScroll: false,
      handleScale: false,
    });
    const area = chart.addSeries(AreaSeries, {
      lineColor: tone,
      lineWidth: 2,
      topColor: `${tone}55`,
      bottomColor: `${tone}05`,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerRadius: 4,
      priceFormat: { type: "custom", minMove: 0.01, formatter: (p: number) => indexFormatter.format(p) },
    });
    const byTime = new Map<number, IndexPoint>();
    for (const p of series) byTime.set(Math.floor(p.ts / 1000), p);
    // 실시간 현재 값을 마지막 점으로 붙여 차트 끝이 헤더 숫자와 맞게 한다.
    if (current != null) {
      const nowSec = Math.floor(Date.now() / 1000);
      const lastSec = Math.max(...byTime.keys());
      byTime.set(Math.max(nowSec, lastSec + 1), { ts: Date.now(), value: current });
    }
    area.setData(
      [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([time, p]) => ({ time: time as UTCTimestamp, value: p.value })),
    );
    chart.timeScale().fitContent();

    const onMove = (param: MouseEventParams) => {
      if (!param.point || typeof param.time !== "number") {
        setHover(null);
        return;
      }
      setHover(byTime.get(param.time as number) ?? null);
    };
    chart.subscribeCrosshairMove(onMove);

    return () => {
      chart.unsubscribeCrosshairMove(onMove);
      chart.chartElement().style.display = "none";
      window.requestAnimationFrame(() => chart.remove());
    };
    // current는 30초 폴링·체결마다 바뀌므로 차트를 다시 만들지 않고 series 갱신에만 맞춘다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, range, theme]);

  function selectRange(next: Range) {
    setRange(next);
    setSeries(null);
    try {
      window.localStorage.setItem(RANGE_STORAGE_KEY, next);
    } catch {
      // ignore
    }
  }

  // 시가총액 가중: 오늘 기여 = (현재가 − 09:00 기준가) × 발행주식수 ÷ 제수, 비중 = 종목 시총 ÷ 편입 시총 합.
  const shares = new Map(meta?.members.map((m) => [m.symbol, m.listedShares]) ?? []);
  const priced = rows
    .filter((r) => shares.has(r.symbol))
    .map((r) => ({ ...r, price: live[r.symbol] ?? r.lastPrice, shares: shares.get(r.symbol) ?? 0 }));
  const totalCap = priced.reduce((sum, r) => sum + r.price * r.shares, 0);
  const contributions = priced
    .map((r) => {
      const rate = r.referencePrice > 0 ? ((r.price - r.referencePrice) / r.referencePrice) * 100 : 0;
      const points = meta && meta.divisor > 0 ? ((r.price - r.referencePrice) * r.shares) / meta.divisor : 0;
      const weight = totalCap > 0 ? ((r.price * r.shares) / totalCap) * 100 : 0;
      return { ...r, rate, points, weight };
    })
    .sort((a, b) => b.weight - a.weight);

  return (
    <div className="space-y-4">
      <div className="glass overflow-hidden">
        <div className="panel-head flex-wrap gap-y-2">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="panel-title">{tr("KABU 지수")}</span>
            {shown && (
              <>
                <span className="num text-2xl font-semibold tracking-tight">{indexFormatter.format(shown.value)}</span>
                {rangeDelta != null && rangeRate != null && (
                  <span className={`num text-sm font-medium whitespace-nowrap ${toneOf(rangeDelta)}`}>
                    {signed(rangeDelta)} ({signed(rangeRate)}%) <span className="text-ink-faint">{rangeLabel}</span>
                  </span>
                )}
                {baseRate != null && (
                  <span className={`num text-xs whitespace-nowrap ${toneOf(baseRate)}`}>
                    {tr("09:00 기준 {base} 대비 {pct}%", { base: indexFormatter.format(sessionBase!), pct: signed(baseRate) })}
                  </span>
                )}
                {hover && <span className="text-[11px] text-ink-faint">{formatKstMonthDay(hover.ts)} {formatKstHm(hover.ts)}</span>}
              </>
            )}
          </div>
          <div className="well flex gap-0.5 p-0.5" role="group" aria-label={tr("기간")}>
            {RANGES.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => selectRange(r.id)}
                aria-pressed={range === r.id}
                title={tr(r.hint)}
                className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                  range === r.id
                    ? "bg-sky/15 text-sky ring-1 ring-inset ring-sky/35"
                    : "text-ink-muted hover:bg-surface-3/45 hover:text-ink"
                }`}
              >
                {tr(r.label)}
              </button>
            ))}
          </div>
        </div>
        <div className="relative p-2">
          <div ref={containerRef} className="h-[20rem] w-full lg:h-[24rem]" />
          {series && series.length === 0 && (
            <p className="absolute inset-0 grid place-items-center text-sm text-ink-faint">{tr("아직 봉 데이터가 없습니다")}</p>
          )}
        </div>
      </div>

      <div className="glass overflow-hidden">
        <div className="panel-head">
          <span className="panel-title">{tr("종목별 기여")}</span>
          <span className="text-[11px] text-ink-faint">{tr("시가총액 가중 · 등락률·기여는 09:00 KST 기준")}</span>
        </div>
        <table className="num w-full text-sm">
          <thead className="text-[11px] text-ink-faint">
            <tr className="border-b border-hairline-soft">
              <th className="px-3 py-2 text-left font-medium sm:px-4">{tr("종목")}</th>
              <th className="hidden px-4 py-2 text-right font-medium sm:table-cell">{tr("오늘 기준가")}</th>
              <th className="px-3 py-2 text-right font-medium sm:px-4">{tr("현재가")}</th>
              <th className="px-3 py-2 text-right font-medium sm:px-4">{tr("등락률")}</th>
              <th className="px-3 py-2 text-right font-medium sm:px-4" title={tr("현재 시가총액 ÷ 편입 종목 시가총액 합")}>{tr("비중")}</th>
              <th className="px-3 py-2 text-right font-medium sm:px-4" title={tr("09:00 기준가 대비 지수 포인트 기여")}>{tr("오늘 기여")}</th>
            </tr>
          </thead>
          <tbody>
            {contributions.map((r) => (
              <tr key={r.symbol} className="border-b border-hairline-soft last:border-b-0">
                <td className="px-3 py-2 sm:px-4">
                  <Link href={`/symbol/${r.symbol}`} className="font-medium hover:text-sky">
                    {r.symbol}
                  </Link>
                  <span className="ml-2 hidden text-xs text-ink-faint sm:inline">{names.symbol(r.symbol, r.name)}</span>
                </td>
                <td className="hidden px-4 py-2 text-right text-ink-muted sm:table-cell">{fmt.format(r.referencePrice)}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap sm:px-4">{fmt.format(r.price)}</td>
                <td className={`px-3 py-2 text-right whitespace-nowrap sm:px-4 ${toneOf(r.rate)}`}>{signed(r.rate)}%</td>
                <td className="px-3 py-2 text-right whitespace-nowrap text-ink-muted sm:px-4">{r.weight.toFixed(1)}%</td>
                <td className={`px-3 py-2 text-right whitespace-nowrap sm:px-4 ${toneOf(r.points)}`}>{signed(r.points)}p</td>
              </tr>
            ))}
            {contributions.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-ink-faint">{tr("종목을 불러오는 중…")}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
