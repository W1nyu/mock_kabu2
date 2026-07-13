import type { ReplayCandle } from "./replay.types";

const utc = (date: string) => Date.parse(`${date}T00:00:00.000Z`);

/**
 * Deterministic offline sample: AAPL daily OHLCV, 2015-08-03..2015-09-04.
 *
 * Values are converted from USD to integer cents from Plotly's
 * `finance-charts-apple.csv` sample data, which is distributed in the
 * MIT-licensed plotly/datasets repository:
 * https://github.com/plotly/datasets/blob/master/finance-charts-apple.csv
 *
 * This is a small visualization fallback, not a financial-grade data feed.
 */
export const AAPL_2015_08_FIXTURE: readonly ReplayCandle[] = [
  { ts: utc("2015-08-03"), open: 12_150, high: 12_257, low: 11_752, close: 11_844, volume: 69_976_000 },
  { ts: utc("2015-08-04"), open: 11_742, high: 11_770, low: 11_325, close: 11_464, volume: 124_138_600 },
  { ts: utc("2015-08-05"), open: 11_295, high: 11_744, low: 11_210, close: 11_540, volume: 99_312_600 },
  { ts: utc("2015-08-06"), open: 11_597, high: 11_650, low: 11_412, close: 11_513, volume: 52_903_000 },
  { ts: utc("2015-08-07"), open: 11_458, high: 11_625, low: 11_450, close: 11_552, volume: 38_670_400 },
  { ts: utc("2015-08-10"), open: 11_653, high: 11_999, low: 11_653, close: 11_972, volume: 54_951_600 },
  { ts: utc("2015-08-11"), open: 11_781, high: 11_818, low: 11_333, close: 11_349, volume: 97_082_800 },
  { ts: utc("2015-08-12"), open: 11_253, high: 11_542, low: 10_963, close: 11_524, volume: 101_217_500 },
  { ts: utc("2015-08-13"), open: 11_604, high: 11_640, low: 11_454, close: 11_515, volume: 48_535_800 },
  { ts: utc("2015-08-14"), open: 11_432, high: 11_631, low: 11_401, close: 11_596, volume: 42_929_500 },
  { ts: utc("2015-08-17"), open: 11_604, high: 11_765, low: 11_550, close: 11_716, volume: 40_884_700 },
  { ts: utc("2015-08-18"), open: 11_643, high: 11_744, low: 11_601, close: 11_650, volume: 34_560_700 },
  { ts: utc("2015-08-19"), open: 11_610, high: 11_652, low: 11_468, close: 11_501, volume: 47_445_700 },
  { ts: utc("2015-08-20"), open: 11_408, high: 11_435, low: 11_163, close: 11_265, volume: 68_501_600 },
  { ts: utc("2015-08-21"), open: 11_043, high: 11_190, low: 10_565, close: 10_576, volume: 128_275_500 },
  { ts: utc("2015-08-24"), open: 9_487, high: 10_880, low: 9_200, close: 10_312, volume: 162_206_300 },
  { ts: utc("2015-08-25"), open: 11_111, high: 11_111, low: 10_350, close: 10_374, volume: 103_601_600 },
  { ts: utc("2015-08-26"), open: 10_709, high: 10_989, low: 10_505, close: 10_969, volume: 96_774_600 },
  { ts: utc("2015-08-27"), open: 11_223, high: 11_324, low: 11_002, close: 11_292, volume: 84_616_100 },
  { ts: utc("2015-08-28"), open: 11_217, high: 11_331, low: 11_154, close: 11_329, volume: 53_164_400 },
  { ts: utc("2015-08-31"), open: 11_203, high: 11_453, low: 11_200, close: 11_276, volume: 56_229_300 },
  { ts: utc("2015-09-01"), open: 11_015, high: 11_188, low: 10_736, close: 10_772, volume: 76_845_900 },
  { ts: utc("2015-09-02"), open: 11_023, high: 11_234, low: 10_913, close: 11_234, volume: 61_888_800 },
  { ts: utc("2015-09-03"), open: 11_249, high: 11_278, low: 11_004, close: 11_037, volume: 53_233_900 },
  { ts: utc("2015-09-04"), open: 10_897, high: 11_045, low: 10_851, close: 10_927, volume: 49_996_300 },
];

export function fixtureFor(datasetId: string): readonly ReplayCandle[] | undefined {
  return datasetId === "aapl-us" ? AAPL_2015_08_FIXTURE : undefined;
}
