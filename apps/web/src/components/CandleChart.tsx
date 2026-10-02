"use client";

import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
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
import { useMyFills, usePositionLines } from "@/lib/usePositionLines";
import { formatKstHm, formatKstMonthDay, formatKstTime } from "@/lib/time";
import { subscribe } from "@/lib/socket";
import { chartTheme, useTheme } from "@/lib/theme";
import { averageAt, type AverageKind } from "@/lib/moving-average";
import { getLocale, translate, useT } from "@/lib/i18n";
import OhlcReadout, { asOhlc, sameOhlc, type Ohlc } from "./OhlcReadout";

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

type HoveredCandle = Ohlc;

interface MovingAverage {
  id: string;
  kind: AverageKind;
  period: number;
  color: string;
  visible: boolean;
}
const DEFAULT_AVERAGES: MovingAverage[] = [
  { id: "sma5", kind: "SMA", period: 5, color: "#f59e0b", visible: true },
  { id: "sma10", kind: "SMA", period: 10, color: "#10b981", visible: true },
  { id: "sma20", kind: "SMA", period: 20, color: "#6366f1", visible: true },
];
const INDICATORS = [{ key: "volume", label: "거래량", color: "#94a3b8" }] as const;
/** 내 포지션 오버레이 — 시리즈가 아니라 마커/가격선이라 따로 켜고 끈다. */
const OVERLAYS = [
  { key: "fills", label: "내 체결", color: "#ff5a6e" },
  { key: "position", label: "평단·예약선", color: "#fbbf24" },
] as const;
type IndicatorKey = (typeof INDICATORS)[number]["key"] | (typeof OVERLAYS)[number]["key"];
type IndicatorState = Record<IndicatorKey, boolean>;

const STORAGE_KEY = "mock-kabu2:chart:indicators";
const AVERAGES_STORAGE_KEY = "mock-kabu2:chart:moving-averages";
const INTERVAL_STORAGE_KEY = "mock-kabu2:chart:interval";
const DEFAULT_STATE: IndicatorState = {
  volume: true,
  fills: true,
  position: true,
};
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

function loadAverages(): MovingAverage[] {
  try {
    const saved = localStorage.getItem(AVERAGES_STORAGE_KEY);
    if (!saved) {
      const legacy = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, unknown>;
      return DEFAULT_AVERAGES.map((item) => ({ ...item, visible: legacy[item.id] !== false }));
    }
    const parsed: unknown = JSON.parse(saved);
    if (!Array.isArray(parsed)) return DEFAULT_AVERAGES;
    const valid = parsed.slice(0, 12).filter((item): item is MovingAverage =>
      item && typeof item.id === "string" && item.id.length <= 80 &&
      (item.kind === "SMA" || item.kind === "EMA" || item.kind === "WMA" || item.kind === "VWMA") &&
      Number.isInteger(item.period) && item.period >= 1 && item.period <= CANDLE_LIMIT &&
      typeof item.color === "string" && /^#[0-9a-fA-F]{6}$/.test(item.color) &&
      typeof item.visible === "boolean",
    );
    // 이전 버전의 기본 3개를 그대로 저장한 사용자만 새 기본값으로 옮긴다.
    if (valid.length === 3 && ["sma50", "sma200", "vwma100"].every((id, index) =>
      valid[index].id === id && valid[index].visible &&
      valid[index].color.toLowerCase() === ["#34d399", "#818cf8", "#cbd5e1"][index]
    )) return DEFAULT_AVERAGES;
    return valid;
  } catch {
    return DEFAULT_AVERAGES;
  }
}

function averageData(candles: Candle[], config: MovingAverage) {
  return candles.flatMap((candle, index) => {
    const value = averageAt(candles, index, config.period, config.kind);
    return value == null ? [] : [{ time: candle.time, value }];
  });
}

function loadInterval(): string {
  try {
    const stored = localStorage.getItem(INTERVAL_STORAGE_KEY);
    return stored && candleIntervalSeconds(stored) !== null ? stored : DEFAULT_CANDLE_INTERVAL;
  } catch {
    return DEFAULT_CANDLE_INTERVAL;
  }
}


function volumeColor(c: Candle): string {
  return c.close >= c.open ? "rgba(255, 90, 110, 0.42)" : "rgba(110, 138, 255, 0.42)";
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
  const t = useT();
  const theme = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candlesRef = useRef<Candle[]>([]);
  const hoveredCandleRef = useRef<HoveredCandle | null>(null);
  const hoveredTimeRef = useRef<UTCTimestamp | null>(null);
  const seriesRef = useRef<{
    candle: ISeriesApi<"Candlestick">;
    volume: ISeriesApi<"Histogram">;
  } | null>(null);
  const averageSeriesRef = useRef(new Map<string, ISeriesApi<"Line">>());
  // SSR과 첫 클라이언트 렌더를 기본값으로 일치시키고(hydration mismatch 방지),
  // localStorage 값은 마운트 후에 반영한다
  const [indicators, setIndicators] = useState<IndicatorState>(DEFAULT_STATE);
  const [averages, setAverages] = useState<MovingAverage[]>(DEFAULT_AVERAGES);
  const [newKind, setNewKind] = useState<AverageKind>("SMA");
  const [newPeriod, setNewPeriod] = useState("20");
  const [averageEditorOpen, setAverageEditorOpen] = useState(false);
  const [newColor, setNewColor] = useState("#fbbf24");
  const [interval, setChartInterval] = useState<string>(DEFAULT_CANDLE_INTERVAL);
  const [hoveredCandle, setHoveredCandle] = useState<HoveredCandle | null>(null);
  const indicatorsRef = useRef(indicators);
  indicatorsRef.current = indicators;
  const averagesRef = useRef(averages);
  averagesRef.current = averages;
  // 내 평단가·예약 트리거 가격선. 차트가 재생성돼도(심볼/봉 간격 전환) 다시 그린다.
  const positionLines = usePositionLines(symbol);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const [chartEpoch, setChartEpoch] = useState(0);
  // 내 체결 마커: 같은 봉의 같은 방향은 한 마커로 합쳐 수량을 적는다.
  const myFills = useMyFills(symbol);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

  useEffect(() => {
    const s = seriesRef.current;
    if (!s) return;
    const bucketSeconds = candleIntervalSeconds(interval) ?? 60;
    const grouped = new Map<string, { time: UTCTimestamp; side: "BUY" | "SELL"; qty: number; amount: number }>();
    for (const fill of myFills) {
      const time = (Math.floor(fill.ts / 1000 / bucketSeconds) * bucketSeconds) as UTCTimestamp;
      const key = `${time}:${fill.side}`;
      const entry = grouped.get(key) ?? { time, side: fill.side, qty: 0, amount: 0 };
      entry.qty += fill.qty;
      entry.amount += fill.qty * fill.price;
      grouped.set(key, entry);
    }
    const markers: SeriesMarker<Time>[] = (indicators.fills ? [...grouped.values()] : [])
      .sort((a, b) => a.time - b.time)
      .map((entry) => ({
        time: entry.time,
        position: entry.side === "BUY" ? "belowBar" : "aboveBar",
        shape: entry.side === "BUY" ? "arrowUp" : "arrowDown",
        color: entry.side === "BUY" ? chartTheme().up : chartTheme().down,
        text: `${translate(getLocale(), entry.side === "BUY" ? "매수" : "매도")} ${entry.qty.toLocaleString("ko-KR")}`,
        size: 1,
      }));
    if (!markersRef.current) markersRef.current = createSeriesMarkers(s.candle, markers);
    else markersRef.current.setMarkers(markers);
  }, [myFills, interval, chartEpoch, indicators.fills, theme]);

  useEffect(() => {
    const s = seriesRef.current;
    if (!s) return;
    for (const line of priceLinesRef.current) s.candle.removePriceLine(line);
    priceLinesRef.current = (indicators.position ? positionLines : []).map((line) =>
      s.candle.createPriceLine({
        price: line.price,
        color: line.color,
        lineWidth: 1,
        lineStyle: line.style,
        axisLabelVisible: true,
        title: line.title,
      }),
    );
  }, [positionLines, chartEpoch, indicators.position]);

  useEffect(() => {
    setIndicators(loadIndicatorState());
    setAverages(loadAverages());
    setChartInterval(loadInterval());
  }, []);

  // 토글 상태 → 시리즈 가시성 동기화 (심볼 전환으로 차트가 재생성돼도 재적용)
  useEffect(() => {
    const s = seriesRef.current;
    if (!s) return;
    s.volume.applyOptions({ visible: indicators.volume });
  }, [indicators, symbol]);

  // Added/removed lines are applied to the existing chart, preserving zoom and scroll.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const series = averageSeriesRef.current;
    const active = new Set(averages.map((item) => item.id));
    for (const [id, line] of series) {
      if (!active.has(id)) {
        chart.removeSeries(line);
        series.delete(id);
      }
    }
    for (const item of averages) {
      let line = series.get(item.id);
      if (!line) {
        line = chart.addSeries(LineSeries, {
          lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
          priceFormat: chartPriceFormat, color: item.color, visible: item.visible,
        });
        series.set(item.id, line);
      }
      line.applyOptions({ color: item.color, visible: item.visible });
      line.setData(averageData(candlesRef.current, item));
    }
  }, [averages, chartEpoch]);

  useEffect(() => {
    if (!containerRef.current) return;

    const bucketSeconds = candleIntervalSeconds(interval) ?? 60;
    const bucketMs = bucketSeconds * 1000;
    const isDaily = interval === DAILY_CANDLE_INTERVAL;

    hoveredCandleRef.current = null;
    hoveredTimeRef.current = null;
    setHoveredCandle(null);

    const colors = chartTheme();
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
      // lightweight-charts has no timezone support and renders a UTCTimestamp
      // as UTC. Rather than shifting the data (which would desynchronise the
      // live-tick bucketing below), relabel the axis and crosshair in KST.
      localization: { timeFormatter: (time: UTCTimestamp) => formatChartTime(time, isDaily) },
      timeScale: {
        // A daily bar's axis should read as dates, not 09:00 over and over.
        timeVisible: !isDaily,
        secondsVisible: false,
        borderColor: colors.border,
        tickMarkFormatter: (time: UTCTimestamp, tickMarkType: TickMarkType) =>
          formatChartTickMark(time, tickMarkType),
      },
      rightPriceScale: {
        borderColor: colors.border,
        scaleMargins: { top: 0.05, bottom: 0.25 },
      },
      crosshair: { mode: 0 },
    });
    const candle = chart.addSeries(CandlestickSeries, {
      upColor: colors.up,
      downColor: colors.down,
      borderUpColor: colors.up,
      borderDownColor: colors.down,
      wickUpColor: colors.up,
      wickDownColor: colors.down,
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

    chartRef.current = chart;
    averageSeriesRef.current = new Map();
    priceLinesRef.current = [];
    markersRef.current = null;
    // 시리즈가 새로 만들어졌으니 가격선 effect를 다시 돌린다.
    setChartEpoch((value) => value + 1);
    seriesRef.current = { candle, volume };

    // 현재 토글 상태 반영 (심볼 전환으로 차트가 재생성돼도 유지)
    const vis = indicatorsRef.current;
    volume.applyOptions({ visible: vis.volume });

    const setCrosshairCandle = (next: HoveredCandle | null) => {
      if (sameOhlc(hoveredCandleRef.current, next)) return;
      hoveredCandleRef.current = next;
      setHoveredCandle(next);
    };

    // `seriesData` makes the crosshair value agree exactly with the rendered candle,
    // including a still-forming realtime candle. This deliberately stays independent
    // from the WebSocket subscription below.
    const handleCrosshairMove = (param: MouseEventParams) => {
      const candleData = asOhlc(param.seriesData.get(candle));
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
      for (const item of averagesRef.current) {
        const value = averageAt(cs, i, item.period, item.kind);
        const line = averageSeriesRef.current.get(item.id);
        if (line && value != null) line.update({ time, value });
      }
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
        for (const item of averagesRef.current) {
          averageSeriesRef.current.get(item.id)?.setData(averageData(cs, item));
        }
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
      averageSeriesRef.current = new Map();
      candlesRef.current = [];
      // lightweight-charts는 paint를 rAF로 미루므로, 동기적으로 remove()하면 이미 예약된
      // 프레임이 폐기된 캔버스를 그리다 "Object is disposed"를 던진다(StrictMode 이중 마운트,
      // 봉 간격 전환). 먼저 숨겨 새 차트와 겹치지 않게 한 뒤 다음 프레임에 제거한다.
      chart.chartElement().style.display = "none";
      window.requestAnimationFrame(() => chart.remove());
    };
  }, [symbol, interval, theme]);

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

  function saveAverages(next: MovingAverage[]) {
    setAverages(next);
    try {
      localStorage.setItem(AVERAGES_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Private browsing can disable storage; the current chart still works.
    }
  }

  function addAverage(event: React.FormEvent) {
    event.preventDefault();
    const period = Number(newPeriod);
    if (!Number.isInteger(period) || period < 1 || period > CANDLE_LIMIT || averages.length >= 12) return;
    saveAverages([...averages, {
      id: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
      kind: newKind, period, color: newColor, visible: true,
    }]);
  }

  return (
    <div className="glass flex flex-col overflow-hidden">
      <div className="panel-head flex-wrap gap-y-2">
        <div className="well flex gap-0.5 p-0.5" role="group" aria-label={t("봉 간격")}>
          {CANDLE_INTERVALS.map((timeframe) => (
            <button
              key={timeframe.id}
              type="button"
              onClick={() => selectInterval(timeframe.id)}
              aria-pressed={interval === timeframe.id}
              className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                interval === timeframe.id
                  ? "bg-sky/15 text-sky ring-1 ring-inset ring-sky/35"
                  : "text-ink-muted hover:bg-surface-3/45 hover:text-ink"
              }`}
            >
              {t(timeframe.label)}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap justify-end gap-1.5">
          {[...INDICATORS, ...OVERLAYS].map((ind) => (
            <button
              key={ind.key}
              onClick={() => toggle(ind.key)}
              aria-pressed={indicators[ind.key]}
              className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
                indicators[ind.key]
                  ? "border-hairline bg-surface-2/70 text-ink"
                  : "border-hairline-soft text-ink-faint hover:text-ink-muted"
              }`}
              title={t("{name} 표시 켜기/끄기", { name: t(ind.label) })}
            >
              <span
                className="inline-block h-2 w-2 rounded-full transition-colors"
                style={{
                  backgroundColor: indicators[ind.key] ? ind.color : "rgba(255,255,255,0.16)",
                }}
              />
              {t(ind.label)}
            </button>
          ))}
          {/* 폰에서는 이평선 편집 줄이 차트를 아래로 밀어내므로 접어 두고 필요할 때만 연다. */}
          <button
            type="button"
            onClick={() => setAverageEditorOpen((open) => !open)}
            aria-expanded={averageEditorOpen}
            className="rounded-full border border-hairline-soft px-2.5 py-0.5 text-[11px] font-medium text-ink-muted lg:hidden"
          >
            {t("이평선")} {averageEditorOpen ? "▴" : "▾"}
          </button>
        </div>
      </div>
      <div className={`border-t border-hairline-soft px-3 py-2 ${averageEditorOpen ? "" : "max-lg:hidden"}`}>
        <div className="flex flex-wrap items-center gap-2" aria-label={t("이동평균선 설정")}>
          <span className="mr-1 text-xs text-ink-muted">{t("이평선")}</span>
          {averages.map((item) => (
            <div key={item.id} className="flex items-center gap-1 rounded-lg border border-hairline bg-surface-2/50 px-1.5 py-1 text-xs">
              <button type="button" onClick={() => saveAverages(averages.map((value) => value.id === item.id ? { ...value, visible: !value.visible } : value))}
                aria-pressed={item.visible} title={t("{name} 표시 켜기/끄기", { name: `${item.period} ${item.kind}` })}
                className={item.visible ? "text-ink" : "text-ink-faint line-through"}>
                {item.period} {item.kind}
              </button>
              <input type="color" value={item.color} aria-label={t("{name} 색상", { name: `${item.period} ${item.kind}` })}
                onChange={(event) => saveAverages(averages.map((value) => value.id === item.id ? { ...value, color: event.target.value } : value))}
                className="h-5 w-6 cursor-pointer border-0 bg-transparent p-0" />
              <button type="button" aria-label={t("{name} 삭제", { name: `${item.period} ${item.kind}` })} title={t("이평선 삭제")}
                onClick={() => saveAverages(averages.filter((value) => value.id !== item.id))}
                className="px-1 text-ink-faint hover:text-up">×</button>
            </div>
          ))}
          <form onSubmit={addAverage} className="flex items-center gap-1.5">
            <select aria-label={t("이평선 종류")} value={newKind} onChange={(event) => setNewKind(event.target.value as AverageKind)}
              className="field h-7 w-20 py-0 text-xs">
              <option value="SMA">SMA</option><option value="EMA">EMA</option><option value="WMA">WMA</option><option value="VWMA">VWMA</option>
            </select>
            <input aria-label={t("이평선 기간")} type="number" min={1} max={CANDLE_LIMIT} value={newPeriod}
              onChange={(event) => setNewPeriod(event.target.value)} className="field num h-7 w-16 py-0 text-xs" />
            <input aria-label={t("새 이평선 색상")} type="color" value={newColor} onChange={(event) => setNewColor(event.target.value)}
              className="h-6 w-7 cursor-pointer border-0 bg-transparent p-0" />
            <button type="submit" disabled={averages.length >= 12} className="btn btn-sm">+ {t("추가")}</button>
          </form>
        </div>
      </div>
      <div className="relative p-2">
        <div ref={containerRef} className="h-[20rem] w-full sm:h-[22rem] lg:h-[26rem]" />
        {hoveredCandle && <OhlcReadout candle={hoveredCandle} format={(value) => priceFormatter.format(value)} />}
      </div>
    </div>
  );
}
