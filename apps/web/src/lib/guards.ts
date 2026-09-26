import type { ConditionalOrderDto } from "@mock-kabu/shared";

const fmt = new Intl.NumberFormat("ko-KR");

function pct(bps: number): string {
  return (bps / 100).toFixed(bps % 100 === 0 ? 0 : 1);
}

/**
 * 대기 중 매도 예약을 "손절 18,900 · 익절 19,000 · 트레일링 3% (현재 18,500)"처럼 한 줄로 요약한다.
 * 손절이 여럿이면 가장 높은(먼저 닿을) 값, 익절이 여럿이면 가장 낮은 값을 대표로 쓴다.
 */
export function guardSummary(
  rows: ConditionalOrderDto[],
  /** 화면 언어 번역(없으면 한국어 그대로) */
  tr: (ko: string, vars?: Record<string, string | number>) => string = (ko, vars) =>
    vars ? ko.replace(/\{(\w+)\}/g, (m, k: string) => String(vars[k] ?? m)) : ko,
): string {
  const parts: string[] = [];
  const trailing = rows.filter((r) => r.trailBps != null);
  const stops = rows.filter((r) => r.trailBps == null && r.direction === "AT_OR_BELOW");
  const takes = rows.filter((r) => r.trailBps == null && r.direction === "AT_OR_ABOVE");
  if (stops.length > 0) parts.push(`${tr("손절")} ${fmt.format(Math.max(...stops.map((r) => r.triggerPrice)))}`);
  if (takes.length > 0) parts.push(`${tr("익절")} ${fmt.format(Math.min(...takes.map((r) => r.triggerPrice)))}`);
  for (const r of trailing) {
    parts.push(tr("트레일링 {pct}% (현재 {price})", { pct: pct(r.trailBps!), price: fmt.format(r.triggerPrice) }));
  }
  return parts.join(" · ");
}
