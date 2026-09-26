"use client";

import Link from "next/link";
import Sparkline from "@/components/Sparkline";
import { formatReference } from "@/lib/reference";
import { useReferenceRows } from "@/lib/useReferenceRows";
import { useNames, useT } from "@/lib/i18n";

function toneClass(delta: number | null): string {
  return delta == null ? "text-ink-faint" : delta > 0 ? "text-up" : delta < 0 ? "text-down" : "text-ink-muted";
}

/**
 * 원/달러·원자재 가상 지수 목록(선물 기초자산). `codes`를 주면 그 코드만(원자재 화면), 없으면 전부(대시보드).
 */
export default function ReferenceList({ codes }: { codes?: readonly string[] } = {}) {
  const t = useT();
  const names = useNames();
  const all = useReferenceRows();
  const list = codes ? all.filter((row) => codes.includes(row.code)) : all;

  return (
    <ul className="divide-y divide-hairline-soft">
      {list.map((row) => {
        const tone = row.spark.length > 1 ? (row.spark.at(-1)! > row.spark[0] ? "up" : row.spark.at(-1)! < row.spark[0] ? "down" : "flat") : "flat";
        return (
          <li key={row.code}>
            <Link
              href={`/reference/${row.code}`}
              className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-3/30 active:bg-surface-3/45"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold">{names.reference(row.code, row.name)}</span>
                <span className="num block truncate text-xs text-ink-faint">{row.code}</span>
              </span>
              <span className="hidden min-[380px]:block">
                <Sparkline values={row.spark.map((v) => v / row.scale)} tone={tone} width={64} height={28} />
              </span>
              <span className="w-[6.5rem] shrink-0 text-right">
                <span className="num block font-semibold">{formatReference(row.value, row)}</span>
                <span className={`num block text-xs font-medium ${toneClass(row.change)}`}>
                  {row.change == null ? "—" : `${row.change > 0 ? "+" : ""}${row.change.toFixed(2)}%`}
                </span>
              </span>
            </Link>
          </li>
        );
      })}
      {list.length === 0 && <li className="py-8 text-center text-sm text-ink-faint">{t("불러오는 중…")}</li>}
    </ul>
  );
}
