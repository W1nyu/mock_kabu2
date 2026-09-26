"use client";

import Link from "next/link";
import { won } from "@/lib/api";
import { fmtOption, fmtStrike, optionLabel, type OptionPosition } from "@/lib/options";
import { useT } from "@/lib/i18n";

function tone(n: number): string {
  return n > 0 ? "text-up" : n < 0 ? "text-down" : "text-ink-muted";
}

/** 매수 원가 대비 수익률(%) — 원가 = 평가액 − 평가손익 */
function rate(p: OptionPosition): number | null {
  const cost = p.value - p.unrealized;
  return cost > 0 ? (p.unrealized / cost) * 100 : null;
}

function RateText({ p }: { p: OptionPosition }) {
  const r = rate(p);
  return r == null ? null : (
    <span className="ml-1 text-xs opacity-80">
      ({r > 0 ? "+" : ""}
      {r.toFixed(2)}%)
    </span>
  );
}

/**
 * 대시보드 보유 자산의 옵션 탭 — 종목(콜/풋·행사가)·수량·평균가·현재가·이론가·평가금액·평가손익(수익률).
 * 선물 탭과 같은 모양. 폰은 한 줄 목록.
 */
export default function OptionHoldings({ positions }: { positions: OptionPosition[] }) {
  const t = useT();
  if (positions.length === 0) {
    return (
      <div className="px-5 py-12 text-center">
        <p className="text-sm text-ink-muted">{t("옵션 포지션이 없습니다.")}</p>
        <p className="mt-1 text-xs text-ink-faint">
          <Link href="/market?kind=futures" className="text-sky">
            {t("증권 → 선물·옵션의 옵션 체인에서 살 수 있습니다 →")}
          </Link>
        </p>
      </div>
    );
  }
  const totalValue = positions.reduce((sum, p) => sum + p.value, 0);
  const totalPnl = positions.reduce((sum, p) => sum + p.unrealized, 0);
  return (
    <>
      <ul className="divide-y divide-hairline-soft sm:hidden">
        {positions.map((p) => (
          <li key={p.symbol}>
            <Link href={`/options/${p.symbol}`} className="flex items-center gap-3 px-4 py-3 active:bg-surface-3/45">
              <span className="min-w-0 flex-1">
                <span className={`block truncate font-semibold ${p.type === "CALL" ? "text-up" : "text-down"}`}>
                  {optionLabel(p.symbol, p.strike)}
                </span>
                <span className="num block text-xs text-ink-faint">
                  {t("{n}계약", { n: p.qty })} · {t("평균")} {fmtOption(p.symbol, Math.round(p.avgPrice))} · {t("현재")} {fmtOption(p.symbol, p.lastPrice)}
                </span>
              </span>
              <span className="shrink-0 text-right">
                <span className={`num block font-semibold ${tone(p.unrealized)}`}>
                  {p.unrealized > 0 ? "+" : ""}
                  {won(p.unrealized)}
                </span>
                <span className="num block text-xs text-ink-faint">{t("평가")} {won(p.value)}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <div className="overflow-x-auto max-sm:hidden">
        <table className="tbl tbl-hover">
          <thead>
            <tr>
              <th>{t("종목")}</th>
              <th className="text-right">{t("행사가")}</th>
              <th className="text-right">{t("수량")}</th>
              <th className="text-right">{t("평균가")}</th>
              <th className="text-right">{t("현재가")}</th>
              <th className="text-right" title={t("블랙-숄즈 이론가 — 호가의 기준")}>
                {t("이론가")}
              </th>
              <th className="text-right">{t("평가금액")}</th>
              <th className="text-right">{t("평가손익")}</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => (
              <tr key={p.symbol}>
                <td className="font-semibold">
                  <Link href={`/options/${p.symbol}`} className={`hover:text-sky ${p.type === "CALL" ? "text-up" : "text-down"}`}>
                    {optionLabel(p.symbol, p.strike).replace(/ [^ ]+$/, "")}
                  </Link>
                </td>
                <td className="num text-right">{fmtStrike(p.symbol, p.strike)}</td>
                <td className="num text-right">{p.qty}</td>
                <td className="num text-right">{fmtOption(p.symbol, Math.round(p.avgPrice))}</td>
                <td className="num text-right">{fmtOption(p.symbol, p.lastPrice)}</td>
                <td className="num text-right text-ink-muted">{fmtOption(p.symbol, p.theo)}</td>
                <td className="num text-right">{won(p.value)}</td>
                <td className={`num text-right font-medium ${tone(p.unrealized)}`}>
                  {p.unrealized > 0 ? "+" : ""}
                  {won(p.unrealized)}
                  <RateText p={p} />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={6} className="text-ink-muted">
                {t("합계")}
              </td>
              <td className="num text-right font-semibold">{won(totalValue)}</td>
              <td className={`num text-right font-semibold ${tone(totalPnl)}`}>
                {totalPnl > 0 ? "+" : ""}
                {won(totalPnl)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="px-4 py-2 text-[11px] text-ink-faint">
        {t("1일물 — 매일 04:10 만기에 내가격이면 차액을 현금으로 받고, 외가격이면 소멸합니다.")}
      </p>
    </>
  );
}
