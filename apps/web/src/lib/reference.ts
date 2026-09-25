import type { ReferenceTick } from "@mock-kabu/shared";

/** `/market/reference` 한 줄. 값은 모두 실제값 × scale 정수. */
export interface ReferenceRow {
  code: string;
  name: string;
  unit: string;
  scale: number;
  decimals: number;
  value: number | null;
  ts: number | null;
  base: number | null;
  spark: number[];
}

/** 저장 정수 → 화면 문자열 (예: 14005 → "1,400.5원", 10123 → "101.23") */
export function formatReference(units: number | null | undefined, row: Pick<ReferenceRow, "scale" | "decimals" | "unit">): string {
  if (units == null || !Number.isFinite(units)) return "—";
  const text = (units / row.scale).toLocaleString("ko-KR", {
    minimumFractionDigits: row.decimals,
    maximumFractionDigits: row.decimals,
  });
  return row.unit === "원" ? `${text}원` : text;
}

/** 오늘 등락률(%) — 기준값이 없으면 null */
export function referenceChange(value: number | null, base: number | null): number | null {
  if (value == null || base == null || base <= 0) return null;
  return ((value - base) / base) * 100;
}

export function parseReferenceTick(data: unknown): ReferenceTick | null {
  if (!data || typeof data !== "object") return null;
  const tick = data as Partial<ReferenceTick>;
  if (typeof tick.code !== "string" || !Number.isFinite(tick.value) || !Number.isFinite(tick.ts)) return null;
  return tick as ReferenceTick;
}
