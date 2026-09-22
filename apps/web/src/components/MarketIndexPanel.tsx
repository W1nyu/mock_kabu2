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
import { formatKstHm, formatKstMonthDay, formatKstTime } from "@/lib/time";

interface SymbolRow {
  symbol: string;
  name: string;
  lastPrice: number;
  initialPrice: number;
}

interface IndexPoint {
  ts: number;
  value: number;
}

type Range = "1d" | "1w" | "all";

const RANGES: { id: Range; label: string; hint: string }[] = [
  { id: "1d", label: "1일", hint: "최근 24시간, 1분 간격" },
  { id: "1w", label: "1주", hint: "최근 7일, 10분 간격" },
  { id: "all", label: "전체", hint: "상장 이후, 1시간 간격" },
];

/** 지수 기준값. 모든 종목이 시초가 그대로면 1,000. */
const INDEX_BASE = 1000;
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
 * 아래 표는 종목별 기여: 시초가 대비 등락률이 곧 그 종목이 지수에 보태는 몫이다.
 */
export default function MarketIndexPanel() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState<Range>("1d");
  const [series, setSeries] = useState<IndexPoint[] | null>(null);
  const [rows, setRows] = useState<SymbolRow[]>([]);
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
          if (active) setRows(data);
        })
        .catch(() => {});
    };
    load();
    const t = window.setInterval(load, REFRESH_MS);
    return () => {
      active = false;
      window.clearInterval(t);
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

  // 현재 지수 — 종목별 현재가/시초가의 평균. 서버 지수와 같은 정의라 차트 마지막 점과 이어진다.
  const current = useMemo(() => {
    const ratios = rows
      .filter((r) => r.initialPrice > 0)
      .map((r) => (live[r.symbol] ?? r.lastPrice) / r.initialPrice);
    if (ratios.length === 0) return null;
    return (ratios.reduce((a, b) => a + b, 0) / ratios.length) * INDEX_BASE;
  }, [rows, live]);

  const first = series && series.length > 0 ? series[0] : null;
  const shown = hover ?? (current != null ? { ts: Date.now(), value: current } : null);
  const rangeDelta = shown && first ? shown.value - first.value : null;
  const rangeRate = rangeDelta != null && first && first.value > 0 ? (rangeDelta / first.value) * 100 : null;
  const baseRate = shown ? ((shown.value - INDEX_BASE) / INDEX_BASE) * 100 : null;
  const rangeLabel = RANGES.find((r) => r.id === range)?.label ?? "";

  useEffect(() => {
    if (!containerRef.current || !series || series.length === 0) return;
    const firstValue = series[0].value;
    const lastValue = current ?? series[series.length - 1].value;
    const tone = lastValue > firstValue ? "#ff5a6e" : lastValue < firstValue ? "#6e8aff" : "#38bdf8";

    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#94a3b8",
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "rgba(255, 255, 255, 0.05)" },
        horzLines: { color: "rgba(255, 255, 255, 0.05)" },
      },
      localization: {
        timeFormatter: (time: UTCTimestamp) =>
          `${formatKstMonthDay(time * 1000)} ${formatKstHm(time * 1000)}`,
        priceFormatter: (price: number) => indexFormatter.format(price),
      },
      timeScale: {
        timeVisible: range !== "all",
        secondsVisible: false,
        borderColor: "rgba(255, 255, 255, 0.10)",
        tickMarkFormatter: tickMark,
      },
      rightPriceScale: {
        borderColor: "rgba(255, 255, 255, 0.10)",
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
    area.createPriceLine({
      price: INDEX_BASE,
      color: "rgba(148, 163, 184, 0.5)",
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: "기준",
    });
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
  }, [series, range]);

  function selectRange(next: Range) {
    setRange(next);
    setSeries(null);
    try {
      window.localStorage.setItem(RANGE_STORAGE_KEY, next);
    } catch {
      // ignore
    }
  }

  const contributions = rows
    .filter((r) => r.initialPrice > 0)
    .map((r) => {
      const price = live[r.symbol] ?? r.lastPrice;
      const rate = ((price - r.initialPrice) / r.initialPrice) * 100;
      // 균등가중이라 지수 기여 = 등락률 ÷ 종목 수 × 1,000 (지수 포인트).
      const points = rows.length > 0 ? ((price / r.initialPrice - 1) * INDEX_BASE) / rows.length : 0;
      return { ...r, price, rate, points };
    })
    .sort((a, b) => b.rate - a.rate);

  return (
    <div className="space-y-4">
      <div className="glass overflow-hidden">
        <div className="panel-head flex-wrap gap-y-2">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="panel-title">KABU 지수</span>
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
                    기준 대비 {signed(baseRate)}%
                  </span>
                )}
                {hover && <span className="text-[11px] text-ink-faint">{formatKstMonthDay(hover.ts)} {formatKstHm(hover.ts)}</span>}
              </>
            )}
          </div>
          <div className="well flex gap-0.5 p-0.5" role="group" aria-label="기간">
            {RANGES.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => selectRange(r.id)}
                aria-pressed={range === r.id}
                title={r.hint}
                className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                  range === r.id
                    ? "bg-sky/15 text-sky ring-1 ring-inset ring-sky/35"
                    : "text-ink-muted hover:bg-white/6 hover:text-ink"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
        <div className="relative p-2">
          <div ref={containerRef} className="h-[20rem] w-full lg:h-[24rem]" />
          {series && series.length === 0 && (
            <p className="absolute inset-0 grid place-items-center text-sm text-ink-faint">아직 봉 데이터가 없습니다</p>
          )}
        </div>
      </div>

      <div className="glass overflow-hidden">
        <div className="panel-head">
          <span className="panel-title">종목별 기여</span>
          <span className="text-[11px] text-ink-faint">균등가중 · 시초가 대비</span>
        </div>
        <table className="num w-full text-sm">
          <thead className="text-[11px] text-ink-faint">
            <tr className="border-b border-hairline-soft">
              <th className="px-3 py-2 text-left font-medium sm:px-4">종목</th>
              <th className="hidden px-4 py-2 text-right font-medium sm:table-cell">시초가</th>
              <th className="px-3 py-2 text-right font-medium sm:px-4">현재가</th>
              <th className="px-3 py-2 text-right font-medium sm:px-4">등락률</th>
              <th className="px-3 py-2 text-right font-medium sm:px-4">지수 기여</th>
            </tr>
          </thead>
          <tbody>
            {contributions.map((r) => (
              <tr key={r.symbol} className="border-b border-hairline-soft last:border-b-0">
                <td className="px-3 py-2 sm:px-4">
                  <Link href={`/symbol/${r.symbol}`} className="font-medium hover:text-sky">
                    {r.symbol}
                  </Link>
                  <span className="ml-2 hidden text-xs text-ink-faint sm:inline">{r.name}</span>
                </td>
                <td className="hidden px-4 py-2 text-right text-ink-muted sm:table-cell">{fmt.format(r.initialPrice)}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap sm:px-4">{fmt.format(r.price)}</td>
                <td className={`px-3 py-2 text-right whitespace-nowrap sm:px-4 ${toneOf(r.rate)}`}>{signed(r.rate)}%</td>
                <td className={`px-3 py-2 text-right whitespace-nowrap sm:px-4 ${toneOf(r.points)}`}>{signed(r.points)}p</td>
              </tr>
            ))}
            {contributions.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-ink-faint">종목을 불러오는 중…</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
