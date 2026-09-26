"use client";

import { won } from "@/lib/api";
import { useT } from "@/lib/i18n";

/**
 * 보유 자산 폰 목록의 합계 줄 — 왼쪽 "합계", 오른쪽 평가손익(원가가 있으면 수익률)과 평가금액(또는 증거금).
 * 표(sm 이상)는 각 표의 tfoot이 같은 값을 보여 준다.
 */
export default function HoldingsTotalItem({
  value,
  pnl,
  cost,
  valueLabel,
}: {
  value: number;
  pnl: number;
  /** 수익률 분모(매입 원가). 없으면 수익률을 쓰지 않는다. */
  cost?: number;
  /** 아래 줄 이름 — 기본 "평가" */
  valueLabel?: string;
}) {
  const t = useT();
  const tone = pnl > 0 ? "text-up" : pnl < 0 ? "text-down" : "text-ink-muted";
  return (
    <li className="flex items-center gap-3 bg-surface-3/20 px-4 py-3">
      <span className="flex-1 text-sm font-medium text-ink-muted">{t("합계")}</span>
      <span className="shrink-0 text-right">
        <span className={`num block font-semibold ${tone}`}>
          {pnl > 0 ? "+" : ""}
          {won(pnl)}
          {cost != null && cost > 0 && (
            <span className="ml-1 text-xs opacity-80">
              ({pnl > 0 ? "+" : ""}
              {((pnl / cost) * 100).toFixed(2)}%)
            </span>
          )}
        </span>
        <span className="num block text-xs text-ink-faint">
          {valueLabel ?? t("평가")} {won(value)}
        </span>
      </span>
    </li>
  );
}
