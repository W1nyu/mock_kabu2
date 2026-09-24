import { kstSessionStartMs } from "./time";

export interface IndexPoint { ts: number; value: number }

/** 09:00의 지수 수준. 그 시각의 점이 없으면 직전 지수 수준을 이어받는다. */
export function indexSessionBase(points: readonly IndexPoint[], at: number): number | null {
  const start = kstSessionStartMs(at);
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (points[mid].ts < start) lo = mid + 1;
    else hi = mid;
  }
  if (points[lo]?.ts === start) return points[lo].value;
  if (lo > 0) return points[lo - 1].value;
  return points[lo]?.ts < start + 86_400_000 ? points[lo].value : null;
}
