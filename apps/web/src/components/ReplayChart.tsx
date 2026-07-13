"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  HistogramSeries,
  LineSeries,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type MouseEventParams,
  type PriceFormatCustom,
  type UTCTimestamp,
} from "lightweight-charts";

/** A source candle for the standalone replay chart. `time` may be epoch seconds, epoch milliseconds, or a date string. */
export interface ReplayChartCandle {
  time: number | string | Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ReplayChartProps {
  /** Full replay dataset, ordered or unordered. Invalid rows are ignored defensively. */
  candles: readonly ReplayChartCandle[];
  /** Number of candles released to the player so far. Omit to render the full dataset. */
  visibleCount?: number;
  /** The active replay candle. Its close is used for the explicit current-price line. */
  currentCandle?: ReplayChartCandle | null;
  /** Optional explicit price-line value when the active price is not a candle close. */
  currentPrice?: number | null;
  className?: string;
}

interface ChartCandle {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface HoveredCandle {
  open: number;
  high: number;
  low: number;
  close: number;
}

const UP = "#ef4444";
const DOWN = "#3b82f6";
const STORAGE_KEY = "replay:chart:indicators";
const INDICATORS = [
  { key: "sma50", label: "50 SMA", color: "#22c55e" },
  { key: "sma200", label: "200 SMA", color: "#ef4444" },
  { key: "vwma100", label: "100 VWMA", color: "#f5f5f5" },
] as const;
type IndicatorKey = (typeof INDICATORS)[number]["key"];
type IndicatorState = Record<IndicatorKey, boolean>;
const DEFAULT_INDICATORS: IndicatorState = { sma50: true, sma200: true, vwma100: true };

function loadIndicators(): IndicatorState {
  try {
    return { ...DEFAULT_INDICATORS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") };
  } catch {
    return DEFAULT_INDICATORS;
  }
}

function timestampOf(value: ReplayChartCandle["time"]): UTCTimestamp | null {
  const raw =
    value instanceof Date ? value.getTime() : typeof value === "string" ? new Date(value).getTime() : value;
  if (!Number.isFinite(raw)) return null;

  // 10-digit epoch values are seconds; modern epoch milliseconds have 13 digits.
  const seconds = Math.floor(Math.abs(raw) >= 10_000_000_000 ? raw / 1_000 : raw);
  return seconds >= 0 ? (seconds as UTCTimestamp) : null;
}

function normalizeCandle(source: ReplayChartCandle): ChartCandle | null {
  const time = timestampOf(source.time);
  if (
    time == null ||
    ![source.open, source.high, source.low, source.close, source.volume].every(Number.isFinite) ||
    source.open <= 0 ||
    source.high <= 0 ||
    source.low <= 0 ||
    source.close <= 0
  ) {
    return null;
  }

  return {
    time,
    open: source.open,
    high: Math.max(source.high, source.open, source.close),
    low: Math.min(source.low, source.open, source.close),
    close: source.close,
    volume: Math.max(0, source.volume),
  };
}

function normalizeCandles(candles: readonly ReplayChartCandle[]): ChartCandle[] {
  // `setData` requires strictly ascending, unique timestamps. Keep the latest row for a duplicated bucket.
  const byTime = new Map<number, ChartCandle>();
  for (const candle of candles) {
    const normalized = normalizeCandle(candle);
    if (normalized) byTime.set(normalized.time as number, normalized);
  }
  return [...byTime.values()].sort((a, b) => (a.time as number) - (b.time as number));
}

function volumeColor(candle: ChartCandle) {
  return candle.close >= candle.open ? "rgba(239, 68, 68, 0.45)" : "rgba(59, 130, 246, 0.45)";
}

/** O(n) rolling SMA. A long `max` replay must remain responsive while advancing every 100 ms. */
function smaData(candles: readonly ChartCandle[], window: number) {
  const result: { time: UTCTimestamp; value: number }[] = [];
  let sum = 0;
  for (let index = 0; index < candles.length; index += 1) {
    sum += candles[index].close;
    if (index >= window) sum -= candles[index - window].close;
    if (index + 1 >= window) result.push({ time: candles[index].time, value: sum / window });
  }
  return result;
}

/** O(n) rolling VWMA: Σ(close × volume) / Σ(volume), omitting zero-volume windows. */
function vwmaData(candles: readonly ChartCandle[], window: number) {
  const result: { time: UTCTimestamp; value: number }[] = [];
  let priceVolume = 0;
  let volume = 0;
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    priceVolume += candle.close * candle.volume;
    volume += candle.volume;
    if (index >= window) {
      const prior = candles[index - window];
      priceVolume -= prior.close * prior.volume;
      volume -= prior.volume;
    }
    if (index + 1 >= window && volume > 0) result.push({ time: candle.time, value: priceVolume / volume });
  }
  return result;
}

function asHoveredCandle(value: unknown): HoveredCandle | null {
  if (typeof value !== "object" || value == null) return null;
  const data = value as Partial<HoveredCandle>;
  if (![data.open, data.high, data.low, data.close].every(Number.isFinite)) return null;
  return { open: data.open!, high: data.high!, low: data.low!, close: data.close! };
}

function sameCandle(a: HoveredCandle | null, b: HoveredCandle | null) {
  return a === b || (!!a && !!b && a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close);
}

function percentFromOpen(price: number, open: number): number {
  return open > 0 ? ((price - open) / open) * 100 : 0;
}

function formatPercent(value: number): string {
  const normalized = Math.abs(value) < 0.005 ? 0 : value;
  return `${normalized > 0 ? "+" : ""}${normalized.toFixed(2)}%`;
}

const priceFormatter = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const chartPriceFormat: PriceFormatCustom = {
  type: "custom",
  minMove: 0.01,
  formatter: (price) => priceFormatter.format(price),
};

/**
 * API/session-independent replay chart. Only the caller-provided visible candles
 * are plotted or used for indicators, so unrevealed future OHLC values remain hidden.
 */
export default function ReplayChart({
  candles,
  visibleCount,
  currentCandle = null,
  currentPrice = null,
  className,
}: ReplayChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const priceLineRef = useRef<IPriceLine | null>(null);
  const hoveredCandleRef = useRef<HoveredCandle | null>(null);
  const hoveredTimeRef = useRef<UTCTimestamp | null>(null);
  const initialTimeRef = useRef<UTCTimestamp | null>(null);
  const indicatorsRef = useRef<IndicatorState>(DEFAULT_INDICATORS);
  const seriesRef = useRef<{
    candle: ISeriesApi<"Candlestick">;
    volume: ISeriesApi<"Histogram">;
    sma50: ISeriesApi<"Line">;
    sma200: ISeriesApi<"Line">;
    vwma100: ISeriesApi<"Line">;
  } | null>(null);
  const [indicators, setIndicators] = useState<IndicatorState>(DEFAULT_INDICATORS);
  const [hoveredCandle, setHoveredCandle] = useState<HoveredCandle | null>(null);

  indicatorsRef.current = indicators;
  const chartCandles = useMemo(() => normalizeCandles(candles), [candles]);
  const visibleCandles = useMemo(() => {
    const count = visibleCount == null ? chartCandles.length : Math.max(0, Math.floor(visibleCount));
    return chartCandles.slice(0, count);
  }, [chartCandles, visibleCount]);
  const activeCandle = useMemo(() => (currentCandle ? normalizeCandle(currentCandle) : null), [currentCandle]);

  useEffect(() => {
    setIndicators(loadIndicators());
  }, []);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    for (const indicator of INDICATORS) series[indicator.key].applyOptions({ visible: indicators[indicator.key] });
  }, [indicators]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
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
      priceLineVisible: false,
      lastValueVisible: false,
      priceFormat: chartPriceFormat,
    });
    const volume = chart.addSeries(HistogramSeries, {
      priceScaleId: "volume",
      priceFormat: { type: "volume" },
      priceLineVisible: false,
      lastValueVisible: false,
    });
    chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    const lineOptions = {
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      priceFormat: chartPriceFormat,
    } as const;
    const sma50 = chart.addSeries(LineSeries, { ...lineOptions, color: "#22c55e" });
    const sma200 = chart.addSeries(LineSeries, { ...lineOptions, color: "#ef4444" });
    const vwma100 = chart.addSeries(LineSeries, { ...lineOptions, color: "#f5f5f5" });
    const visibility = indicatorsRef.current;
    sma50.applyOptions({ visible: visibility.sma50 });
    sma200.applyOptions({ visible: visibility.sma200 });
    vwma100.applyOptions({ visible: visibility.vwma100 });

    const setCrosshairCandle = (next: HoveredCandle | null) => {
      if (sameCandle(hoveredCandleRef.current, next)) return;
      hoveredCandleRef.current = next;
      setHoveredCandle(next);
    };
    const handleCrosshairMove = (param: MouseEventParams) => {
      const candleData = asHoveredCandle(param.seriesData.get(candle));
      if (!param.point || !candleData || typeof param.time !== "number") {
        hoveredTimeRef.current = null;
        setCrosshairCandle(null);
        return;
      }
      hoveredTimeRef.current = param.time as UTCTimestamp;
      setCrosshairCandle(candleData);
    };
    chart.subscribeCrosshairMove(handleCrosshairMove);

    chartRef.current = chart;
    seriesRef.current = { candle, volume, sma50, sma200, vwma100 };

    return () => {
      if (priceLineRef.current) candle.removePriceLine(priceLineRef.current);
      priceLineRef.current = null;
      seriesRef.current = null;
      chartRef.current = null;
      hoveredCandleRef.current = null;
      hoveredTimeRef.current = null;
      initialTimeRef.current = null;
      chart.unsubscribeCrosshairMove(handleCrosshairMove);
      chart.remove();
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return;

    series.candle.setData(visibleCandles);
    series.volume.setData(
      visibleCandles.map((candle) => ({
        time: candle.time,
        value: candle.volume,
        color: volumeColor(candle),
      })),
    );
    series.sma50.setData(smaData(visibleCandles, 50));
    series.sma200.setData(smaData(visibleCandles, 200));
    series.vwma100.setData(vwmaData(visibleCandles, 100));

    if (hoveredTimeRef.current != null) {
      const updated = visibleCandles.find((candle) => candle.time === hoveredTimeRef.current);
      if (updated) {
        const next = { open: updated.open, high: updated.high, low: updated.low, close: updated.close };
        if (!sameCandle(hoveredCandleRef.current, next)) {
          hoveredCandleRef.current = next;
          setHoveredCandle(next);
        }
      }
    }

    if (priceLineRef.current) {
      series.candle.removePriceLine(priceLineRef.current);
      priceLineRef.current = null;
    }
    const explicitPrice = currentPrice != null && Number.isFinite(currentPrice) && currentPrice > 0 ? currentPrice : null;
    const derivedPrice = explicitPrice ?? activeCandle?.close ?? visibleCandles.at(-1)?.close;
    if (derivedPrice != null && Number.isFinite(derivedPrice) && derivedPrice > 0) {
      priceLineRef.current = series.candle.createPriceLine({
        price: derivedPrice,
        color: "#facc15",
        lineWidth: 1,
        axisLabelVisible: true,
        title: "현재가",
      });
    }

    const firstTime = visibleCandles[0]?.time ?? null;
    if (firstTime != null && initialTimeRef.current !== firstTime) {
      initialTimeRef.current = firstTime;
      chart.timeScale().fitContent();
    } else if (visibleCandles.length > 0) {
      chart.timeScale().scrollToRealTime();
    }
  }, [activeCandle, currentPrice, visibleCandles]);

  function toggleIndicator(key: IndicatorKey) {
    const next = { ...indicatorsRef.current, [key]: !indicatorsRef.current[key] };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Browsers may deny storage in private contexts; the current view still works.
    }
    setIndicators(next);
  }

  return (
    <div>
      <div className="flex flex-wrap gap-1.5 px-1 pb-2">
        {INDICATORS.map((indicator) => (
          <button
            key={indicator.key}
            type="button"
            onClick={() => toggleIndicator(indicator.key)}
            className={`flex items-center gap-1.5 rounded border px-2 py-0.5 text-xs ${
              indicators[indicator.key]
                ? "border-neutral-700 bg-neutral-800 text-neutral-200"
                : "border-neutral-800 text-neutral-600"
            }`}
            title={`${indicator.label} 표시 켜기/끄기`}
          >
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: indicators[indicator.key] ? indicator.color : "#525252" }}
            />
            {indicator.label}
          </button>
        ))}
      </div>
      <div className="relative">
        <div ref={containerRef} className={`h-80 w-full ${className ?? ""}`} />
        {hoveredCandle && <OhlcReadout candle={hoveredCandle} />}
      </div>
    </div>
  );
}

function OhlcReadout({ candle }: { candle: HoveredCandle }) {
  const values = [
    { label: "시가", value: candle.open },
    { label: "고가", value: candle.high },
    { label: "저가", value: candle.low },
    { label: "종가", value: candle.close },
  ];

  return (
    <div
      aria-live="polite"
      className="pointer-events-none absolute left-2 top-2 z-10 flex max-w-[calc(100%-1rem)] flex-wrap items-center gap-x-2 gap-y-0.5 rounded border border-neutral-700/80 bg-neutral-950/85 px-2 py-1 text-[11px] tabular-nums shadow-sm backdrop-blur-sm sm:gap-x-3 sm:text-xs"
      data-testid="replay-chart-ohlc-readout"
    >
      {values.map(({ label, value }) => {
        const rate = percentFromOpen(value, candle.open);
        const tone = rate > 0 ? "text-red-400" : rate < 0 ? "text-blue-400" : "text-neutral-300";
        return (
          <span key={label} className="whitespace-nowrap text-neutral-300">
            <span className="mr-1 text-neutral-500">{label}</span>
            {priceFormatter.format(value)}
            <span className={`ml-1 ${tone}`}>({formatPercent(rate)})</span>
          </span>
        );
      })}
    </div>
  );
}
