export interface EquityLike {
  equity: number;
}

export interface Drawdown {
  /** 최고 자산 대비 최대 낙폭 비율 (0~1) */
  maxDrawdown: number;
  peak: number;
  /** 현재 자산의 최고점 대비 낙폭 (0~1) */
  current: number;
}

/** 자산 추이 전체 구간에서 최고점 대비 최대 낙폭(MDD)과 현재 낙폭을 구한다. 점이 2개 미만이면 null. */
export function drawdownOf(points: EquityLike[]): Drawdown | null {
  if (points.length < 2) return null;
  let peak = points[0].equity;
  let maxDrawdown = 0;
  for (const p of points) {
    if (p.equity > peak) peak = p.equity;
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - p.equity) / peak);
  }
  const last = points[points.length - 1].equity;
  return { maxDrawdown, peak, current: peak > 0 ? Math.max(0, (peak - last) / peak) : 0 };
}
