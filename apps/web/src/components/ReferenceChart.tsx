"use client";

import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  TickMarkType,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { candleIntervalSeconds, DAILY_CANDLE_INTERVAL } from "@mock-kabu/shared";
import ChipTabs from "@/components/ChipTabs";
import { api } from "@/lib/api";
import { parseReferenceTick } from "@/lib/reference";
import { subscribe } from "@/lib/socket";
import { chartTheme, useTheme } from "@/lib/theme";
import { formatKstHm, formatKstMonthDay, formatKstTime } from "@/lib/time";

/**
 * 가상 기초자산(원/달러·원자재) 봉 차트. 거래량·내 체결이 없는 가격 지수라 현물 CandleChart보다
 * 단순하다. 값은 저장 정수를 scale로 나눠 그리고, 실시간 값으로 마지막 봉을 움직인다.
 */
const INTERVALS = [
  { id: "1m", label: "1분" },
  { id: "5m", label: "5분" },
  { id: "15m", label: "15분" },
  { id: "1h", label: "1시간" },
  { id: "4h", label: "4시간" },
  { id: "1d", label: "1일" },
];
const LIMIT = 500;

interface CandleDto {
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export default function ReferenceChart({ code, scale, decimals }: { code: string; scale: number; decimals: number }) {
  const theme = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const [interval, setChartInterval] = useState("5m");

  useEffect(() => {
    if (!containerRef.current) return;
    const colors = chartTheme();
    const isDaily = interval === DAILY_CANDLE_INTERVAL;
    const bucketSeconds = candleIntervalSeconds(interval) ?? 300;
    const chart: IChartApi = createChart(containerRef.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: colors.text, attributionLogo: false },
      grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
      localization: {
        timeFormatter: (time: UTCTimestamp) =>
          isDaily ? formatKstMonthDay(time * 1000) : `${formatKstMonthDay(time * 1000)} ${formatKstHm(time * 1000)}`,
      },
      timeScale: {
        timeVisible: !isDaily,
        secondsVisible: false,
        borderColor: colors.border,
        tickMarkFormatter: (time: UTCTimestamp, type: TickMarkType) =>
          type === TickMarkType.Year || type === TickMarkType.Month || type === TickMarkType.DayOfMonth
            ? formatKstMonthDay(time * 1000)
            : type === TickMarkType.TimeWithSeconds
              ? formatKstTime(time * 1000)
              : formatKstHm(time * 1000),
      },
      rightPriceScale: { borderColor: colors.border },
      crosshair: { mode: 0 },
    });
    const series: ISeriesApi<"Candlestick"> = chart.addSeries(CandlestickSeries, {
      upColor: colors.up,
      downColor: colors.down,
      borderUpColor: colors.up,
      borderDownColor: colors.down,
      wickUpColor: colors.up,
      wickDownColor: colors.down,
      priceFormat: { type: "price", precision: decimals, minMove: 1 / 10 ** decimals },
    });

    let active = true;
    let last: { time: UTCTimestamp; open: number; high: number; low: number; close: number } | null = null;
    api<CandleDto[]>(`/market/reference/${code}/candles?interval=${interval}&limit=${LIMIT}`, { auth: false })
      .then((rows) => {
        if (!active) return;
        const bars = rows.map((row) => ({
          time: Math.floor(Date.parse(row.ts) / 1000) as UTCTimestamp,
          open: row.open / scale,
          high: row.high / scale,
          low: row.low / scale,
          close: row.close / scale,
        }));
        series.setData(bars);
        last = bars.at(-1) ?? null;
        chart.timeScale().fitContent();
      })
      .catch(() => {});

    const unsubscribe = subscribe([`ref:${code}`], ({ data }) => {
      const tick = parseReferenceTick(data);
      if (!tick || !active) return;
      const value = tick.value / scale;
      const time = (Math.floor(tick.ts / 1000 / bucketSeconds) * bucketSeconds) as UTCTimestamp;
      if (last && last.time === time) {
        last = { ...last, high: Math.max(last.high, value), low: Math.min(last.low, value), close: value };
      } else if (!last || time > last.time) {
        last = { time, open: value, high: value, low: value, close: value };
      } else {
        return;
      }
      series.update(last);
    });

    return () => {
      active = false;
      unsubscribe();
      chart.remove();
    };
  }, [code, scale, decimals, interval, theme]);

  return (
    <div className="space-y-3">
      <ChipTabs label="봉 간격" size="sm" items={INTERVALS} value={interval} onChange={setChartInterval} />
      <div ref={containerRef} className="h-[320px] w-full sm:h-[420px]" />
    </div>
  );
}
