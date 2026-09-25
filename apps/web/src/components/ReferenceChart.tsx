"use client";

import UnitCandleChart from "@/components/UnitCandleChart";
import { parseReferenceTick } from "@/lib/reference";

/** 가상 기초자산(원/달러·원자재) 봉 차트. */
export default function ReferenceChart({ code, scale, decimals }: { code: string; scale: number; decimals: number }) {
  return (
    <UnitCandleChart
      candlesUrl={(interval, limit) => `/market/reference/${code}/candles?interval=${interval}&limit=${limit}`}
      channel={`ref:${code}`}
      tickFrom={(data) => parseReferenceTick(data)}
      scale={scale}
      decimals={decimals}
    />
  );
}
