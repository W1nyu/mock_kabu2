"use client";

import { useEffect, useRef, useState } from "react";
import {
  AreaSeries,
  ColorType,
  createChart,
  type MouseEventParams,
  TickMarkType,
  type UTCTimestamp,
} from "lightweight-charts";
import { api, getToken, won } from "@/lib/api";
import { formatKstHm, formatKstMonthDay, formatKstTime } from "@/lib/time";
import { chartTheme, useTheme } from "@/lib/theme";
import { everyVisible } from "@/lib/visible-interval";

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
  const theme = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState<Range>("1d");
  const [points, setPoints] = useState<EquityPoint[] | null>(null);
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
    };
    load();
    const t = everyVisible(load, REFRESH_MS);
    return () => {
      active = false;
      t();
    };
  }, [range, refreshKey]);

  useEffect(() => {
    if (!containerRef.current || !points || points.length === 0) return;
    const first = points[0].equity;
    const last = points[points.length - 1].equity;
    const colors = chartTheme();
    const tone = last > first ? colors.up : last < first ? colors.down : colors.sky;
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
        priceFormatter: (price: number) => priceFormatter.format(price),
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
  }, [points, range, theme]);

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
              <span className="ml-2 hidden text-ink-faint sm:inline">
                {hover ? formatKstTime(hover.ts).slice(0, 5) : "현재"} · 현금 {won(shown.cash)} ·
                주식 {won(shown.stockValue)}
              </span>
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
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
                    : "text-ink-muted hover:bg-surface-3/45 hover:text-ink"
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
