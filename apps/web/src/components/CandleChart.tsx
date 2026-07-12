"use client";

import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  HistogramSeries,
  LineSeries,
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
  volume: number;
}

interface Candle {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// 한국 관례: 상승=빨강, 하락=파랑 (양극 인코딩, dataviz 규칙: 텍스트는 뉴트럴 잉크)
const UP = "#ef4444";
const DOWN = "#3b82f6";

/** 지표 정의 — 기본: 50 SMA(초록), 200 SMA(빨강), 100 VWMA(하양), 거래량 */
const INDICATORS = [
  { key: "sma50", label: "50 SMA", color: "#22c55e" },
  { key: "sma200", label: "200 SMA", color: "#ef4444" },
  { key: "vwma100", label: "100 VWMA", color: "#f5f5f5" },
  { key: "volume", label: "거래량", color: "#a3a3a3" },
] as const;
type IndicatorKey = (typeof INDICATORS)[number]["key"];
type IndicatorState = Record<IndicatorKey, boolean>;

const STORAGE_KEY = "chart:indicators";
const DEFAULT_STATE: IndicatorState = { sma50: true, sma200: true, vwma100: true, volume: true };

function loadIndicatorState(): IndicatorState {
  try {
    return { ...DEFAULT_STATE, ...JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") };
  } catch {
    return DEFAULT_STATE;
  }
}

/** 종가 단순이동평균 — 윈도우 미달 구간은 null */
function smaAt(candles: Candle[], i: number, window: number): number | null {
  if (i + 1 < window) return null;
  let sum = 0;
  for (let k = i - window + 1; k <= i; k++) sum += candles[k].close;
  return sum / window;
}

/** 거래량가중이동평균 — Σ(종가×거래량)/Σ거래량, 거래량 합이 0이면 null */
function vwmaAt(candles: Candle[], i: number, window: number): number | null {
  if (i + 1 < window) return null;
  let pv = 0;
  let v = 0;
  for (let k = i - window + 1; k <= i; k++) {
    pv += candles[k].close * candles[k].volume;
    v += candles[k].volume;
  }
  return v > 0 ? pv / v : null;
}

function volumeColor(c: Candle): string {
  return c.close >= c.open ? "rgba(239, 68, 68, 0.45)" : "rgba(59, 130, 246, 0.45)";
}

export default function CandleChart({ symbol }: { symbol: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candlesRef = useRef<Candle[]>([]);
  const seriesRef = useRef<{
    candle: ISeriesApi<"Candlestick">;
    volume: ISeriesApi<"Histogram">;
    sma50: ISeriesApi<"Line">;
    sma200: ISeriesApi<"Line">;
    vwma100: ISeriesApi<"Line">;
  } | null>(null);
  // SSR과 첫 클라이언트 렌더를 기본값으로 일치시키고(hydration mismatch 방지),
  // localStorage 값은 마운트 후에 반영한다
  const [indicators, setIndicators] = useState<IndicatorState>(DEFAULT_STATE);
  const indicatorsRef = useRef(indicators);
  indicatorsRef.current = indicators;

  useEffect(() => {
    setIndicators(loadIndicatorState());
  }, []);

  // 토글 상태 → 시리즈 가시성 동기화 (심볼 전환으로 차트가 재생성돼도 재적용)
  useEffect(() => {
    const s = seriesRef.current;
    if (!s) return;
    for (const ind of INDICATORS) s[ind.key].applyOptions({ visible: indicators[ind.key] });
  }, [indicators, symbol]);

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
      rightPriceScale: { borderColor: "#404040", scaleMargins: { top: 0.05, bottom: 0.25 } },
      crosshair: { mode: 0 },
    });
    const candle = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderUpColor: UP,
      borderDownColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
    });
    // 거래량: 차트 하단 20%를 쓰는 별도 스케일의 히스토그램
    const volume = chart.addSeries(HistogramSeries, {
      priceScaleId: "volume",
      priceFormat: { type: "volume" },
      priceLineVisible: false,
      lastValueVisible: false,
    });
    chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    const lineOpts = { lineWidth: 1, priceLineVisible: false, lastValueVisible: false } as const;
    const sma50 = chart.addSeries(LineSeries, { ...lineOpts, color: "#22c55e" });
    const sma200 = chart.addSeries(LineSeries, { ...lineOpts, color: "#ef4444" });
    const vwma100 = chart.addSeries(LineSeries, { ...lineOpts, color: "#f5f5f5" });

    chartRef.current = chart;
    seriesRef.current = { candle, volume, sma50, sma200, vwma100 };

    // 현재 토글 상태 반영 (심볼 전환으로 차트가 재생성돼도 유지)
    const vis = indicatorsRef.current;
    sma50.applyOptions({ visible: vis.sma50 });
    sma200.applyOptions({ visible: vis.sma200 });
    vwma100.applyOptions({ visible: vis.vwma100 });
    volume.applyOptions({ visible: vis.volume });

    /** 마지막 캔들 기준으로 각 지표의 최신 포인트만 갱신 */
    const updateIndicatorsAtLast = () => {
      const cs = candlesRef.current;
      const i = cs.length - 1;
      if (i < 0) return;
      const time = cs[i].time;
      const s50 = smaAt(cs, i, 50);
      const s200 = smaAt(cs, i, 200);
      const v100 = vwmaAt(cs, i, 100);
      if (s50 != null) sma50.update({ time, value: s50 });
      if (s200 != null) sma200.update({ time, value: s200 });
      if (v100 != null) vwma100.update({ time, value: v100 });
      volume.update({ time, value: cs[i].volume, color: volumeColor(cs[i]) });
    };

    api<CandleDto[]>(`/market/candles/${symbol}?interval=1m&limit=500`, { auth: false })
      .then((rows) => {
        const cs: Candle[] = rows.map((c) => ({
          time: (new Date(c.ts).getTime() / 1000) as UTCTimestamp,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: Number(c.volume) || 0,
        }));
        candlesRef.current = cs;
        candle.setData(cs);
        volume.setData(cs.map((c) => ({ time: c.time, value: c.volume, color: volumeColor(c) })));
        const line = (fn: typeof smaAt, w: number) =>
          cs.flatMap((c, i) => {
            const v = fn(cs, i, w);
            return v != null ? [{ time: c.time, value: v }] : [];
          });
        sma50.setData(line(smaAt, 50));
        sma200.setData(line(smaAt, 200));
        vwma100.setData(line(vwmaAt, 100));
        chart.timeScale().scrollToRealTime();
      })
      .catch(() => {});

    const unsub = subscribe([`trades:${symbol}`], ({ data }) => {
      // 오염된 페이로드가 차트를 죽이지 않도록 방어 (NaN이 들어가면 시리즈 전체가 깨짐)
      if (!Number.isFinite(data?.price) || !Number.isFinite(data?.ts)) return;
      const price: number = data.price;
      const qty: number = Number.isFinite(data?.qty) ? data.qty : 0;
      const bucket = (Math.floor(data.ts / 60_000) * 60) as UTCTimestamp;
      const cs = candlesRef.current;
      const last = cs[cs.length - 1];
      if (last && last.time === bucket) {
        last.high = Math.max(last.high, price);
        last.low = Math.min(last.low, price);
        last.close = price;
        last.volume += qty;
        candle.update(last);
      } else {
        const next: Candle = { time: bucket, open: price, high: price, low: price, close: price, volume: qty };
        cs.push(next);
        candle.update(next);
      }
      updateIndicatorsAtLast();
    });

    return () => {
      unsub();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      candlesRef.current = [];
    };
  }, [symbol]);

  function toggle(key: IndicatorKey) {
    const next = { ...indicatorsRef.current, [key]: !indicatorsRef.current[key] };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // 저장 실패는 무시 (프라이빗 모드 등)
    }
    setIndicators(next);
  }

  return (
    <div>
      <div className="flex flex-wrap gap-1.5 px-1 pb-2">
        {INDICATORS.map((ind) => (
          <button
            key={ind.key}
            onClick={() => toggle(ind.key)}
            className={`flex items-center gap-1.5 rounded border px-2 py-0.5 text-xs ${
              indicators[ind.key]
                ? "border-neutral-700 bg-neutral-800 text-neutral-200"
                : "border-neutral-800 text-neutral-600"
            }`}
            title={`${ind.label} 표시 켜기/끄기`}
          >
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: indicators[ind.key] ? ind.color : "#525252" }}
            />
            {ind.label}
          </button>
        ))}
      </div>
      <div ref={containerRef} className="h-80 w-full" />
    </div>
  );
}
