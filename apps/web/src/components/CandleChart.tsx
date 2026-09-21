"use client";

import { useEffect, useRef, useState } from "react";
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
  TickMarkType,
  type PriceFormatCustom,
  type UTCTimestamp,
} from "lightweight-charts";
import {
  CANDLE_INTERVALS,
  candleIntervalSeconds,
  DAILY_CANDLE_INTERVAL,
  DEFAULT_CANDLE_INTERVAL,
} from "@mock-kabu/shared";
import { api } from "@/lib/api";
import { usePositionLines } from "@/lib/usePositionLines";
import { formatKstHm, formatKstMonthDay, formatKstTime } from "@/lib/time";
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

interface HoveredCandle {
  open: number;
  high: number;
  low: number;
  close: number;
}

// 한국 관례: 상승=빨강, 하락=파랑. 하락 파랑은 sky 액센트(#38BDF8)와 구분되도록
// 인디고 쪽으로 밀어, 차트에서 "클릭 가능"과 "하락"이 같은 색으로 읽히지 않게 한다.
const UP = "#ff5a6e";
const DOWN = "#6e8aff";

/** 지표 정의 — 기본: 50 SMA(민트), 200 SMA(인디고), 100 VWMA(슬레이트), 거래량 */
const INDICATORS = [
  { key: "sma50", label: "50 SMA", color: "#34d399" },
  { key: "sma200", label: "200 SMA", color: "#818cf8" },
  { key: "vwma100", label: "100 VWMA", color: "#cbd5e1" },
  { key: "volume", label: "거래량", color: "#94a3b8" },
] as const;
type IndicatorKey = (typeof INDICATORS)[number]["key"];
type IndicatorState = Record<IndicatorKey, boolean>;

const STORAGE_KEY = "mock-kabu2:chart:indicators";
const INTERVAL_STORAGE_KEY = "mock-kabu2:chart:interval";
const DEFAULT_STATE: IndicatorState = { sma50: true, sma200: true, vwma100: true, volume: true };
const CANDLE_LIMIT = 500;
/** Below this, fit the whole series instead of holding the default bar spacing. */
const SPARSE_BAR_COUNT = 60;

function loadIndicatorState(): IndicatorState {
  try {
    return { ...DEFAULT_STATE, ...JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") };
  } catch {
    return DEFAULT_STATE;
  }
}

function loadInterval(): string {
  try {
    const stored = localStorage.getItem(INTERVAL_STORAGE_KEY);
    return stored && candleIntervalSeconds(stored) !== null ? stored : DEFAULT_CANDLE_INTERVAL;
  } catch {
    return DEFAULT_CANDLE_INTERVAL;
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
  return c.close >= c.open ? "rgba(255, 90, 110, 0.42)" : "rgba(110, 138, 255, 0.42)";
}

function asHoveredCandle(value: unknown): HoveredCandle | null {
  if (typeof value !== "object" || value == null) return null;
  const data = value as Partial<HoveredCandle>;
  if (![data.open, data.high, data.low, data.close].every(Number.isFinite)) return null;
  return { open: data.open!, high: data.high!, low: data.low!, close: data.close! };
}

function sameCandle(a: HoveredCandle | null, b: HoveredCandle | null): boolean {
  return a === b || (!!a && !!b && a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close);
}

function percentFromOpen(price: number, open: number): number {
  return open > 0 ? ((price - open) / open) * 100 : 0;
}

function formatPercent(value: number): string {
  // Avoid a visually noisy "-0.00%" when the difference is smaller than the display precision.
  const normalized = Math.abs(value) < 0.005 ? 0 : value;
  return `${normalized > 0 ? "+" : ""}${normalized.toFixed(2)}%`;
}

/**
 * The chart speaks in UTCTimestamp seconds. These render the same instant on
 * the KST clock so the axis agrees with the trade tape beside it.
 */
function formatChartTime(time: UTCTimestamp, daily: boolean): string {
  const ms = time * 1000;
  // A daily bar has no meaningful intraday time to show; an intraday bar needs
  // its date once the chart spans more than one session.
  return daily ? formatKstMonthDay(ms) : `${formatKstMonthDay(ms)} ${formatKstHm(ms)}`;
}

function formatChartTickMark(time: UTCTimestamp, tickMarkType: TickMarkType): string {
  const ms = time * 1000;
  switch (tickMarkType) {
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

const priceFormatter = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 });
const chartPriceFormat: PriceFormatCustom = {
  type: "custom",
  minMove: 1,
  formatter: (price) => priceFormatter.format(price),
};

export default function CandleChart({ symbol }: { symbol: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candlesRef = useRef<Candle[]>([]);
  const hoveredCandleRef = useRef<HoveredCandle | null>(null);
  const hoveredTimeRef = useRef<UTCTimestamp | null>(null);
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
  const [interval, setChartInterval] = useState<string>(DEFAULT_CANDLE_INTERVAL);
  const [hoveredCandle, setHoveredCandle] = useState<HoveredCandle | null>(null);
  const indicatorsRef = useRef(indicators);
  indicatorsRef.current = indicators;
  // 내 평단가·예약 트리거 가격선. 차트가 재생성돼도(심볼/봉 간격 전환) 다시 그린다.
  const positionLines = usePositionLines(symbol);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const [chartEpoch, setChartEpoch] = useState(0);

  useEffect(() => {
    const s = seriesRef.current;
    if (!s) return;
    for (const line of priceLinesRef.current) s.candle.removePriceLine(line);
    priceLinesRef.current = positionLines.map((line) =>
      s.candle.createPriceLine({
        price: line.price,
        color: line.color,
        lineWidth: 1,
        lineStyle: line.style,
        axisLabelVisible: true,
        title: line.title,
      }),
    );
  }, [positionLines, chartEpoch]);

  useEffect(() => {
    setIndicators(loadIndicatorState());
    setChartInterval(loadInterval());
  }, []);

  // 토글 상태 → 시리즈 가시성 동기화 (심볼 전환으로 차트가 재생성돼도 재적용)
  useEffect(() => {
    const s = seriesRef.current;
    if (!s) return;
    for (const ind of INDICATORS) s[ind.key].applyOptions({ visible: indicators[ind.key] });
  }, [indicators, symbol]);

  useEffect(() => {
    if (!containerRef.current) return;

    const bucketSeconds = candleIntervalSeconds(interval) ?? 60;
    const bucketMs = bucketSeconds * 1000;
    const isDaily = interval === DAILY_CANDLE_INTERVAL;

    hoveredCandleRef.current = null;
    hoveredTimeRef.current = null;
    setHoveredCandle(null);

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
      // lightweight-charts has no timezone support and renders a UTCTimestamp
      // as UTC. Rather than shifting the data (which would desynchronise the
      // live-tick bucketing below), relabel the axis and crosshair in KST.
      localization: { timeFormatter: (time: UTCTimestamp) => formatChartTime(time, isDaily) },
      timeScale: {
        // A daily bar's axis should read as dates, not 09:00 over and over.
        timeVisible: !isDaily,
        secondsVisible: false,
        borderColor: "rgba(255, 255, 255, 0.10)",
        tickMarkFormatter: (time: UTCTimestamp, tickMarkType: TickMarkType) =>
          formatChartTickMark(time, tickMarkType),
      },
      rightPriceScale: {
        borderColor: "rgba(255, 255, 255, 0.10)",
        scaleMargins: { top: 0.05, bottom: 0.25 },
      },
      crosshair: { mode: 0 },
    });
    const candle = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderUpColor: UP,
      borderDownColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
      priceFormat: chartPriceFormat,
    });
    // 거래량: 차트 하단 20%를 쓰는 별도 스케일의 히스토그램
    const volume = chart.addSeries(HistogramSeries, {
      priceScaleId: "volume",
      priceFormat: { type: "volume" },
      priceLineVisible: false,
      lastValueVisible: false,
    });
    chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    const lineOpts = {
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      priceFormat: chartPriceFormat,
    } as const;
    const sma50 = chart.addSeries(LineSeries, { ...lineOpts, color: "#34d399" });
    const sma200 = chart.addSeries(LineSeries, { ...lineOpts, color: "#818cf8" });
    const vwma100 = chart.addSeries(LineSeries, { ...lineOpts, color: "#cbd5e1" });

    chartRef.current = chart;
    priceLinesRef.current = [];
    // 시리즈가 새로 만들어졌으니 가격선 effect를 다시 돌린다.
    setChartEpoch((value) => value + 1);
    seriesRef.current = { candle, volume, sma50, sma200, vwma100 };

    // 현재 토글 상태 반영 (심볼 전환으로 차트가 재생성돼도 유지)
    const vis = indicatorsRef.current;
    sma50.applyOptions({ visible: vis.sma50 });
    sma200.applyOptions({ visible: vis.sma200 });
    vwma100.applyOptions({ visible: vis.vwma100 });
    volume.applyOptions({ visible: vis.volume });

    const setCrosshairCandle = (next: HoveredCandle | null) => {
      if (sameCandle(hoveredCandleRef.current, next)) return;
      hoveredCandleRef.current = next;
      setHoveredCandle(next);
    };

    // `seriesData` makes the crosshair value agree exactly with the rendered candle,
    // including a still-forming realtime candle. This deliberately stays independent
    // from the WebSocket subscription below.
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

      // Keep the readout accurate when a user is holding the crosshair over the
      // live candle and trades continue to update its high/low/close values.
      if (hoveredTimeRef.current === time) setCrosshairCandle(cs[i]);
    };

    // 언마운트/종목 전환 뒤 도착한 응답이나 tick이 제거된 차트를 건드리지 않게 한다.
    let disposed = false;

    api<CandleDto[]>(`/market/candles/${symbol}?interval=${interval}&limit=${CANDLE_LIMIT}`, {
      auth: false,
    })
      .then((rows) => {
        if (disposed) return;
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
        // A coarse timeframe early in a market's life has only a handful of
        // bars; keeping the fine-grained bar spacing would pin them to the
        // right edge as a sliver. Fit the view until there is enough history
        // for scrolling to be the more useful behaviour.
        if (cs.length <= SPARSE_BAR_COUNT) chart.timeScale().fitContent();
        else chart.timeScale().scrollToRealTime();
      })
      .catch(() => {});

    const unsub = subscribe([`trades:${symbol}`], ({ data }) => {
      if (disposed) return;
      // 오염된 페이로드가 차트를 죽이지 않도록 방어 (NaN이 들어가면 시리즈 전체가 깨짐)
      if (!Number.isFinite(data?.price) || !Number.isFinite(data?.ts)) return;
      const price: number = data.price;
      const qty: number = Number.isFinite(data?.qty) ? data.qty : 0;
      const bucket = (Math.floor(data.ts / bucketMs) * bucketSeconds) as UTCTimestamp;
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
      disposed = true;
      unsub();
      chart.unsubscribeCrosshairMove(handleCrosshairMove);
      chartRef.current = null;
      seriesRef.current = null;
      candlesRef.current = [];
      // lightweight-charts는 paint를 rAF로 미루므로, 동기적으로 remove()하면 이미 예약된
      // 프레임이 폐기된 캔버스를 그리다 "Object is disposed"를 던진다(StrictMode 이중 마운트,
      // 봉 간격 전환). 먼저 숨겨 새 차트와 겹치지 않게 한 뒤 다음 프레임에 제거한다.
      chart.chartElement().style.display = "none";
      window.requestAnimationFrame(() => chart.remove());
    };
  }, [symbol, interval]);

  function selectInterval(next: string) {
    try {
      localStorage.setItem(INTERVAL_STORAGE_KEY, next);
    } catch {
      // 저장 실패는 무시 (프라이빗 모드 등)
    }
    setChartInterval(next);
  }

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
    <div className="glass flex flex-col overflow-hidden">
      <div className="panel-head flex-wrap gap-y-2">
        <div className="well flex gap-0.5 p-0.5" role="group" aria-label="봉 간격">
          {CANDLE_INTERVALS.map((timeframe) => (
            <button
              key={timeframe.id}
              type="button"
              onClick={() => selectInterval(timeframe.id)}
              aria-pressed={interval === timeframe.id}
              className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                interval === timeframe.id
                  ? "bg-sky/15 text-sky ring-1 ring-inset ring-sky/35"
                  : "text-ink-muted hover:bg-white/6 hover:text-ink"
              }`}
            >
              {timeframe.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap justify-end gap-1.5">
          {INDICATORS.map((ind) => (
            <button
              key={ind.key}
              onClick={() => toggle(ind.key)}
              aria-pressed={indicators[ind.key]}
              className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
                indicators[ind.key]
                  ? "border-hairline bg-surface-2/70 text-ink"
                  : "border-hairline-soft text-ink-faint hover:text-ink-muted"
              }`}
              title={`${ind.label} 표시 켜기/끄기`}
            >
              <span
                className="inline-block h-2 w-2 rounded-full transition-colors"
                style={{
                  backgroundColor: indicators[ind.key] ? ind.color : "rgba(255,255,255,0.16)",
                }}
              />
              {ind.label}
            </button>
          ))}
        </div>
      </div>
      <div className="relative p-2">
        <div ref={containerRef} className="h-[22rem] w-full lg:h-[26rem]" />
        {hoveredCandle && <OhlcReadout candle={hoveredCandle} />}
      </div>
    </div>
  );
}

function OhlcReadout({ candle }: { candle: HoveredCandle }) {
  const values = [
    { label: "시", value: candle.open },
    { label: "고", value: candle.high },
    { label: "저", value: candle.low },
    { label: "종", value: candle.close },
  ];

  return (
    <div
      aria-live="polite"
      className="num pointer-events-none absolute top-4 left-4 z-10 flex max-w-[calc(100%-2rem)] flex-wrap items-center gap-x-2 gap-y-0.5 rounded-[10px] border border-hairline bg-abyss-deep/80 px-2.5 py-1.5 text-[11px] backdrop-blur-md sm:gap-x-3 sm:text-xs"
      data-testid="chart-ohlc-readout"
    >
      {values.map(({ label, value }) => {
        const rate = percentFromOpen(value, candle.open);
        const tone = rate > 0 ? "text-up" : rate < 0 ? "text-down" : "text-ink-muted";
        return (
          <span key={label} className="whitespace-nowrap text-ink">
            <span className="mr-1 text-ink-faint">{label}</span>
            {priceFormatter.format(value)}
            <span className={`ml-1 ${tone}`}>({formatPercent(rate)})</span>
          </span>
        );
      })}
    </div>
  );
}
