"use client";

import { useT } from "@/lib/i18n";

export interface Ohlc {
  open: number;
  high: number;
  low: number;
  close: number;
}

/** 크로스헤어가 가리키는 봉의 값(lightweight-charts seriesData) → 시고저종, 값이 아니면 null */
export function asOhlc(value: unknown): Ohlc | null {
  if (typeof value !== "object" || value == null) return null;
  const data = value as Partial<Ohlc>;
  if (![data.open, data.high, data.low, data.close].every(Number.isFinite)) return null;
  return { open: data.open!, high: data.high!, low: data.low!, close: data.close! };
}

export function sameOhlc(a: Ohlc | null, b: Ohlc | null): boolean {
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

/** 차트 왼쪽 위 시·고·저·종 표시 — 각 값 옆에 시가 대비 등락률(%). 현물·선물·원자재·환 차트가 같이 쓴다. */
export default function OhlcReadout({ candle, format }: { candle: Ohlc; format: (value: number) => string }) {
  const t = useT();
  const values = [
    { label: t("시"), value: candle.open },
    { label: t("고"), value: candle.high },
    { label: t("저"), value: candle.low },
    { label: t("종"), value: candle.close },
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
            {format(value)}
            <span className={`ml-1 ${tone}`}>({formatPercent(rate)})</span>
          </span>
        );
      })}
    </div>
  );
}
