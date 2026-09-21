"use client";

import { sparklineGeometry } from "@/lib/sparkline";

/**
 * 종목 표 안의 미니 추세선. 값 배열을 폭 100 × 높이 28의 SVG polyline으로 그리며 색은 호출자가
 * 등락에 맞춰 넘긴다. 점이 2개 미만이면 빈 자리만 차지해 표 행 높이가 흔들리지 않는다.
 */
export default function Sparkline({
  values,
  tone,
  width = 96,
  height = 28,
}: {
  values: number[];
  tone: "up" | "down" | "flat";
  width?: number;
  height?: number;
}) {
  const stroke = tone === "up" ? "#ff5a6e" : tone === "down" ? "#6e8aff" : "#94a3b8";
  const geometry = sparklineGeometry(values, width, height);
  if (!geometry) {
    return <svg width={width} height={height} aria-hidden className="block" />;
  }
  const { points, lastX, lastY } = geometry;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden
      className="block"
    >
      <polyline
        points={points}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        opacity={0.9}
      />
      <circle cx={lastX} cy={lastY} r={2} fill={stroke} />
    </svg>
  );
}
