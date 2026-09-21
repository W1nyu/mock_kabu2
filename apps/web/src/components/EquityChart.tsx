"use client";

import { useEffect, useRef, useState } from "react";
import {
  AreaSeries,
  ColorType,
  createChart,
  LineSeries,
  type MouseEventParams,
  TickMarkType,
  type UTCTimestamp,
} from "lightweight-charts";
import { api, getToken, won } from "@/lib/api";
import { formatKstHm, formatKstMonthDay, formatKstTime } from "@/lib/time";

interface EquityPoint {
  ts: number;
  cash: number;
  stockValue: number;
  equity: number;
}

type Range = "1d" | "1w" | "all";

const RANGES: { id: Range; label: string; hint: string }[] = [
  { id: "1d", label: "1일", hint: "최근 24시간, 1분 간격" },
  { id: "1w", label: "1주", hint: "최근 7일, 10분 간격" },
  { id: "all", label: "전체", hint: "가입 이후, 1시간 간격" },
];

const RANGE_STORAGE_KEY = "dashboard:equity-range";
const REFRESH_MS = 60_000;

const priceFormatter = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 });

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

/**
 * 대시보드 자산 추이. 서버가 매 분 기록한 스냅샷(현금+보유평가액)을 구간별 버킷으로 읽어
 * 면적 차트로 그린다. 첫 점 대비 증감이 색을 정한다(상승=빨강, 하락=파랑).
 */
export default function EquityChart({ refreshKey }: { refreshKey?: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState<Range>("1d");
  const [points, setPoints] = useState<EquityPoint[] | null>(null);
  const [index, setIndex] = useState<{ ts: number; value: number }[]>([]);
  const [showIndex, setShowIndex] = useState(true);
  const [hover, setHover] = useState<EquityPoint | null>(null);

  // localStorage는 마운트 후에만 읽는다 — 초기값에서 읽으면 hydration mismatch.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(RANGE_STORAGE_KEY);
      if (saved === "1d" || saved === "1w" || saved === "all") setRange(saved);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (!getToken()) return;
    let active = true;
    const load = () => {
      api<EquityPoint[]>(`/account/equity?range=${range}`)
        .then((rows) => {
          if (active) setPoints(rows);
        })
        .catch(() => {});
      api<{ ts: number; value: number }[]>(`/market/index?range=${range}`, { auth: false })
        .then((rows) => {
          if (active) setIndex(rows);
        })
        .catch(() => {});
    };
    load();
    const t = window.setInterval(load, REFRESH_MS);
    return () => {
      active = false;
      window.clearInterval(t);
    };
  }, [range, refreshKey]);

  useEffect(() => {
    if (!containerRef.current || !points || points.length === 0) return;
    const first = points[0].equity;
    const last = points[points.length - 1].equity;
    const tone = last > first ? "#ff5a6e" : last < first ? "#6e8aff" : "#38bdf8";

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
        priceFormatter: (price: number) => priceFormatter.format(price),
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
      priceFormat: {
        type: "custom",
        minMove: 1,
        formatter: (p: number) => priceFormatter.format(p),
      },
    });
    // 같은 시각이 중복되면 setData가 거부하므로 정렬·중복 제거한다.
    const byTime = new Map<number, EquityPoint>();
    for (const p of points) byTime.set(Math.floor(p.ts / 1000), p);
    const data = [...byTime.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([time, p]) => ({ time: time as UTCTimestamp, value: p.equity }));
    area.setData(data);

    // 시장 지수를 내 첫 자산에 맞춰 정규화한 비교선 — 지수가 같은 비율로 움직였다면 내 자산이 어디 있었을지.
    if (showIndex && index.length >= 2 && data.length >= 1) {
      const startTime = data[0].time as number;
      const base = index.find((p) => Math.floor(p.ts / 1000) >= startTime) ?? index[0];
      if (base && base.value > 0) {
        const indexLine = chart.addSeries(LineSeries, {
          color: "rgba(148, 163, 184, 0.7)",
          lineWidth: 1,
          lineStyle: 2,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
          priceFormat: {
            type: "custom",
            minMove: 1,
            formatter: (p: number) => priceFormatter.format(p),
          },
        });
        const seen = new Set<number>();
        indexLine.setData(
          index
            .map((p) => ({
              time: Math.floor(p.ts / 1000) as UTCTimestamp,
              value: (p.value / base.value) * first,
            }))
            .filter(
              (p) =>
                (p.time as number) >= startTime &&
                !seen.has(p.time as number) &&
                seen.add(p.time as number),
            ),
        );
      }
    }
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
      // 예약된 paint가 폐기된 캔버스를 그리지 않게 숨긴 뒤 다음 프레임에 제거 (CandleChart와 동일)
      chart.chartElement().style.display = "none";
      window.requestAnimationFrame(() => chart.remove());
    };
  }, [points, range, index, showIndex]);

  function selectRange(next: Range) {
    setRange(next);
    setPoints(null);
    try {
      window.localStorage.setItem(RANGE_STORAGE_KEY, next);
    } catch {
      // ignore
    }
  }

  const first = points?.[0];
  const last = points?.[points.length - 1];
  const shown = hover ?? last ?? null;
  const change = shown && first ? shown.equity - first.equity : null;
  const changeRate =
    change != null && first && first.equity > 0 ? (change / first.equity) * 100 : null;
  const changeTone =
    change == null || change === 0 ? "text-ink-muted" : change > 0 ? "text-up" : "text-down";
  const hasData = (points?.length ?? 0) >= 2;
  // 같은 구간의 지수 등락 — 내 수익률과 나란히 읽는다.
  const indexStart =
    first && index.length >= 2
      ? (index.find((p) => Math.floor(p.ts / 1000) >= Math.floor(first.ts / 1000)) ?? index[0])
      : null;
  const indexEnd = index.length >= 1 ? index[index.length - 1] : null;
  const indexRate =
    indexStart && indexEnd && indexStart.value > 0
      ? ((indexEnd.value - indexStart.value) / indexStart.value) * 100
      : null;

  return (
    <section className="glass overflow-hidden">
      <div className="panel-head flex-wrap gap-y-2">
        <div className="flex items-baseline gap-3">
          <span className="panel-title">자산 추이</span>
          {shown && (
            <span className="num text-xs text-ink-muted">
              <span className="font-semibold text-ink">{won(shown.equity)}</span>
              {change != null && changeRate != null && (
                <span className={`ml-2 ${changeTone}`}>
                  {change > 0 ? "+" : ""}
                  {won(change)} ({change > 0 ? "+" : ""}
                  {changeRate.toFixed(2)}%)
                </span>
              )}
              <span className="ml-2 text-ink-faint">
                {hover ? formatKstTime(hover.ts).slice(0, 5) : "현재"} · 현금 {won(shown.cash)} ·
                주식 {won(shown.stockValue)}
              </span>
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowIndex((v) => !v)}
            aria-pressed={showIndex}
            title="5종목 동일가중 지수를 내 시작 자산에 맞춰 겹쳐 그립니다"
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
              showIndex
                ? "border-hairline bg-surface-2/70 text-ink"
                : "border-hairline-soft text-ink-faint hover:text-ink-muted"
            }`}
          >
            <span className="inline-block h-0 w-3 border-t border-dashed border-ink-muted" />
            시장 지수
            {indexRate != null && (
              <span
                className={`num ${indexRate > 0 ? "text-up" : indexRate < 0 ? "text-down" : "text-ink-muted"}`}
              >
                {indexRate > 0 ? "+" : ""}
                {indexRate.toFixed(2)}%
              </span>
            )}
          </button>
          <div className="well flex gap-0.5 p-0.5" role="group" aria-label="조회 구간">
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
      </div>
      <div className="relative p-2">
        {hasData ? (
          <div ref={containerRef} className="h-44 w-full sm:h-52" />
        ) : (
          <div className="grid h-44 place-items-center text-center sm:h-52">
            <p className="text-sm text-ink-faint">
              {points == null
                ? "자산 추이를 불러오는 중…"
                : "아직 스냅샷이 쌓이지 않았습니다. 매 분 자동으로 기록됩니다."}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
