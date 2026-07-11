"use client";

import { useEffect, useRef } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { api } from "@/lib/api";
import { subscribe } from "@/lib/socket";

interface CandleDto {
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

// 한국 관례: 상승=빨강, 하락=파랑 (양극 인코딩, dataviz 규칙: 텍스트는 뉴트럴 잉크)
const UP = "#ef4444";
const DOWN = "#3b82f6";

export default function CandleChart({ symbol }: { symbol: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const lastCandleRef = useRef<{ time: UTCTimestamp; open: number; high: number; low: number; close: number } | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#a3a3a3",
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "#262626" },
        horzLines: { color: "#262626" },
      },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: "#404040" },
      rightPriceScale: { borderColor: "#404040" },
      crosshair: { mode: 0 },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderUpColor: UP,
      borderDownColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
    });
    chartRef.current = chart;
    seriesRef.current = series;

    api<CandleDto[]>(`/market/candles/${symbol}?interval=1m&limit=180`, { auth: false })
      .then((rows) => {
        const data = rows.map((c) => ({
          time: (new Date(c.ts).getTime() / 1000) as UTCTimestamp,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        }));
        series.setData(data);
        lastCandleRef.current = data[data.length - 1] ?? null;
        chart.timeScale().scrollToRealTime();
      })
      .catch(() => {});

    const unsub = subscribe([`trades:${symbol}`], ({ data }) => {
      const price: number = data.price;
      const bucket = (Math.floor(data.ts / 60_000) * 60) as UTCTimestamp;
      const last = lastCandleRef.current;
      if (last && last.time === bucket) {
        last.high = Math.max(last.high, price);
        last.low = Math.min(last.low, price);
        last.close = price;
        series.update(last);
      } else {
        const candle = { time: bucket, open: price, high: price, low: price, close: price };
        lastCandleRef.current = candle;
        series.update(candle);
      }
    });

    return () => {
      unsub();
      chart.remove();
      chartRef.current = null;
    };
  }, [symbol]);

  return <div ref={containerRef} className="h-80 w-full" />;
}
