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
import { subscribe } from "@/lib/socket";
import { chartTheme, useTheme } from "@/lib/theme";
import { formatKstHm, formatKstMonthDay, formatKstTime } from "@/lib/time";

/**
 * 정수 단위 가격(실제값 × scale)을 쓰는 봉 차트 — 선물 기초자산(가상 지수)과 선물이 함께 쓴다.
 * 현물 CandleChart의 내 체결·평단가·거래량 기능이 없는 가벼운 차트다. 봉은 `candlesUrl`에서 읽고,
 * 실시간 값(`channel`의 메시지를 `tickFrom`이 {값, 시각}으로 바꾼 것)으로 마지막 봉을 움직인다.
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

export interface UnitTick {
  /** 정수 단위 값 */
  value: number;
  /** epoch ms */
  ts: number;
}

export default function UnitCandleChart({
  candlesUrl,
  channel,
  tickFrom,
  scale,
  decimals,
}: {
  candlesUrl: (interval: string, limit: number) => string;
  channel: string;
  tickFrom: (data: unknown) => UnitTick | null;
  scale: number;
  decimals: number;
}) {
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
    api<CandleDto[]>(candlesUrl(interval, LIMIT), { auth: false })
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

    const unsubscribe = subscribe([channel], ({ data }) => {
      const tick = tickFrom(data);
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
    // candlesUrl·tickFrom은 호출자가 매 렌더 새로 만들 수 있어 의존성에서 뺀다 — 채널이 같으면 같은 차트다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, scale, decimals, interval, theme]);

  return (
    <div className="space-y-3">
      <ChipTabs label="봉 간격" size="sm" items={INTERVALS} value={interval} onChange={setChartInterval} />
      <div ref={containerRef} className="h-[320px] w-full sm:h-[420px]" />
    </div>
  );
}
