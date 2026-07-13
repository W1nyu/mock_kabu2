import type { ReplayCandle, ReplayRange } from "./replay.types";

/**
 * Select a calendar window relative to the newest source candle. Providers
 * must pass chronologically sorted candles; this preserves the source rows
 * without inventing missing market days.
 */
export function selectReplayRange(candles: readonly ReplayCandle[], range: ReplayRange): ReplayCandle[] {
  if (range === "max") return [...candles];
  const latest = candles.at(-1);
  if (!latest) return [];

  const months = range === "1mo" ? 1
    : range === "3mo" ? 3
      : range === "6mo" ? 6
        : range === "1y" ? 12
          : range === "2y" ? 24
            : range === "5y" ? 60
              : 120;
  const cutoff = subtractCalendarMonths(latest.ts, months);
  return candles.filter((candle) => candle.ts >= cutoff);
}

function subtractCalendarMonths(timestamp: number, months: number): number {
  const source = new Date(timestamp);
  const targetMonthIndex = source.getUTCFullYear() * 12 + source.getUTCMonth() - months;
  const targetYear = Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return Date.UTC(
    targetYear,
    targetMonth,
    Math.min(source.getUTCDate(), lastDay),
    source.getUTCHours(),
    source.getUTCMinutes(),
    source.getUTCSeconds(),
    source.getUTCMilliseconds(),
  );
}
