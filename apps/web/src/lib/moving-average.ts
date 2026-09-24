export type AverageKind = "SMA" | "EMA" | "WMA" | "VWMA";

export interface AverageCandle { close: number; volume: number }

/** 완성된 기간만 표시한다. EMA는 첫 기간의 SMA로 시작한다. */
export function averageAt(candles: readonly AverageCandle[], i: number, period: number, kind: AverageKind): number | null {
  if (i + 1 < period || period < 1) return null;
  if (kind === "EMA") {
    let seed = 0;
    for (let k = 0; k < period; k++) seed += candles[k].close;
    let value = seed / period;
    const weight = 2 / (period + 1);
    for (let k = period; k <= i; k++) value = candles[k].close * weight + value * (1 - weight);
    return value;
  }
  let numerator = 0;
  let denominator = 0;
  for (let k = 0; k < period; k++) {
    const candle = candles[i - period + 1 + k];
    const weight = kind === "WMA" ? k + 1 : kind === "VWMA" ? candle.volume : 1;
    numerator += candle.close * weight;
    denominator += weight;
  }
  return denominator > 0 ? numerator / denominator : null;
}
