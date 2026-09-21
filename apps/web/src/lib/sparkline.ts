export interface SparklineGeometry {
  /** "x,y x,y …" — SVG polyline points 속성값 */
  points: string;
  lastX: number;
  lastY: number;
}

/**
 * 값 배열을 폭·높이 안의 polyline 좌표로. 값이 모두 같으면 가운데 수평선이 되도록 span을 1로 본다.
 * 점이 2개 미만이면 null.
 */
export function sparklineGeometry(values: number[], width: number, height: number, pad = 2): SparklineGeometry | null {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const stepX = (width - pad * 2) / (values.length - 1);
  const y = (v: number) => pad + (1 - (v - min) / span) * (height - pad * 2);
  const points = values.map((v, i) => `${(pad + i * stepX).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return { points, lastX: pad + (values.length - 1) * stepX, lastY: y(values[values.length - 1]) };
}
