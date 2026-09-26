"use client";

import Link from "next/link";
import Sparkline from "@/components/Sparkline";
import { formatReference } from "@/lib/reference";
import { FX_CODE, kcomIndex, useReferenceRows } from "@/lib/useReferenceRows";
import { useNames, useT } from "@/lib/i18n";

function toneClass(delta: number | null): string {
  return delta == null ? "text-ink-faint" : delta > 0 ? "text-up" : delta < 0 ? "text-down" : "text-ink-muted";
}
function sparkTone(values: number[]): "up" | "down" | "flat" {
  if (values.length < 2) return "flat";
  return values.at(-1)! > values[0] ? "up" : values.at(-1)! < values[0] ? "down" : "flat";
}
const pct = (change: number | null) => (change == null ? "—" : `${change > 0 ? "+" : ""}${change.toFixed(2)}%`);

/**
 * 증권 탭의 KABU 지수 카드 아래 두 카드: 환율(누르면 원/달러 화면), 원자재(누르면 원자재 화면).
 * 지수 카드와 같은 모양으로, 목록 대신 요약만 보여 준다.
 */
export default function ReferenceCards() {
  const t = useT();
  const names = useNames();
  const rows = useReferenceRows();
  const fx = rows.find((row) => row.code === FX_CODE) ?? null;
  const commodities = rows.filter((row) => row.code !== FX_CODE);
  const kcom = kcomIndex(rows);

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Link
        href={`/reference/${FX_CODE}`}
        className="glass flex items-center gap-4 p-4 transition-colors active:bg-surface-3/40 sm:p-5"
      >
        <div className="min-w-0 flex-1">
          <p className="text-[13px] text-ink-muted">{t("환율")} · {names.reference("USDKRW", "원/달러")}</p>
          <p className="num mt-1 text-2xl font-semibold tracking-tight">{fx ? formatReference(fx.value, fx) : "—"}</p>
          <p className={`num mt-0.5 text-[13px] font-medium ${toneClass(fx?.change ?? null)}`}>
            {fx ? `${pct(fx.change)} ${t("오늘")}` : "—"}
          </p>
        </div>
        {fx && <Sparkline values={fx.spark.map((v) => v / fx.scale)} tone={sparkTone(fx.spark)} width={96} height={40} />}
        <span aria-hidden className="text-ink-faint">
          ›
        </span>
      </Link>

      <Link href="/commodities" className="glass flex items-center gap-4 p-4 transition-colors active:bg-surface-3/40 sm:p-5">
        <div className="min-w-0 flex-1">
          <p className="flex items-baseline justify-between gap-2 text-[13px] text-ink-muted">
            <span>{commodities.length > 0 ? t("원자재 {n}종", { n: commodities.length }) : t("원자재")}</span>
            {kcom && (
              <span className="num" title={t("원자재지수 KCOM — 5종 평균(기준 100), KCOM 옵션의 기초자산")}>
                KCOM <span className="font-semibold text-ink">{kcom.value.toFixed(2)}</span>{" "}
                <span className={toneClass(kcom.change)}>{pct(kcom.change)}</span>
              </span>
            )}
          </p>
          <ul className="num mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[13px]">
            {commodities.map((row) => (
              <li key={row.code} className="flex justify-between gap-2">
                <span className="truncate text-ink-muted">{names.reference(row.code, row.name)}</span>
                <span className={`font-medium ${toneClass(row.change)}`}>{pct(row.change)}</span>
              </li>
            ))}
            {commodities.length === 0 && <li className="text-ink-faint">{t("불러오는 중…")}</li>}
          </ul>
        </div>
        <span aria-hidden className="text-ink-faint">
          ›
        </span>
      </Link>
    </div>
  );
}
