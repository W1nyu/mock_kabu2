"use client";

import { futureDef } from "@mock-kabu/shared";
import Link from "next/link";
import { won } from "@/lib/api";
import { fmtFuture, leverageLabel, type FuturesAccount } from "@/lib/futures";
import { useNames, useT } from "@/lib/i18n";
import HoldingsTotalItem from "./HoldingsTotalItem";

function tone(n: number): string {
  return n > 0 ? "text-up" : n < 0 ? "text-down" : "text-ink-muted";
}

/** 대시보드 보유 자산의 선물 탭 — 포지션별 방향·수량·레버리지·평균가·평가가격·평가손익·증거금. 폰은 한 줄 목록. */
export default function FuturesHoldings({ account }: { account: FuturesAccount | null }) {
  const t = useT();
  const positions = account?.positions ?? [];
  if (positions.length === 0) {
    return (
      <div className="px-5 py-12 text-center">
        <p className="text-sm text-ink-muted">{t("선물 포지션이 없습니다.")}</p>
        <p className="mt-1 text-xs text-ink-faint">
          <Link href="/market?kind=futures" className="text-sky">
            {t("증권 → 선물·옵션에서 거래할 수 있습니다 →")}
          </Link>
        </p>
      </div>
    );
  }
  return <FuturesRows positions={positions} />;
}

function FuturesRows({ positions }: { positions: FuturesAccount["positions"] }) {
  const t = useT();
  const names = useNames();
  const totalMargin = positions.reduce((sum, p) => sum + p.marginHeld, 0);
  const totalPnl = positions.reduce((sum, p) => sum + p.unrealized, 0);
  return (
    <>
      <ul className="divide-y divide-hairline-soft sm:hidden">
        {positions.map((p) => {
          const name = names.future(p.symbol, futureDef(p.symbol)?.name ?? p.symbol);
          return (
            <li key={`${p.symbol}:${p.positionSide}`}>
              <Link
                href={`/futures/${p.symbol}`}
                className="flex items-center gap-3 px-4 py-3 active:bg-surface-3/45"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">{name}</span>
                  <span className="num block text-xs text-ink-faint">
                    <span className={p.qty > 0 ? "text-up" : "text-down"}>
                      {p.qty > 0 ? t("롱") : t("숏")} {t("{n}계약", { n: Math.abs(p.qty) })}
                    </span>{" "}
                    · {leverageLabel(p.symbol, p.leverage)} · {t("평균")}{" "}
                    {fmtFuture(p.symbol, Math.round(p.avgPrice))}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className={`num block font-semibold ${tone(p.unrealized)}`}>
                    {p.unrealized > 0 ? "+" : ""}
                    {won(p.unrealized)}
                  </span>
                  <span className="num block text-xs text-ink-faint">
                    {t("증거금")} {won(p.marginHeld)}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
        <HoldingsTotalItem
          value={totalMargin}
          pnl={totalPnl}
          cost={totalMargin}
          valueLabel={t("증거금")}
        />
      </ul>
      <div className="overflow-x-auto max-sm:hidden">
        <table className="tbl tbl-hover">
          <thead>
            <tr>
              <th>{t("종목")}</th>
              <th className="text-right">{t("포지션")}</th>
              <th className="text-right">{t("레버리지")}</th>
              <th className="text-right">{t("평균가")}</th>
              <th
                className="text-right"
                title={t(
                  "기초자산·최근 체결 중앙값·최근가의 중앙값 — 평가손익과 반대매매 판단에 쓴다",
                )}
              >
                {t("평가가격")}
              </th>
              <th className="text-right">{t("증거금")}</th>
              <th className="text-right">{t("평가손익")}</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => (
              <tr key={`${p.symbol}:${p.positionSide}`}>
                <td className="font-semibold">
                  <Link href={`/futures/${p.symbol}`} className="hover:text-sky">
                    {p.symbol}
                  </Link>
                </td>
                <td className={`num text-right font-medium ${p.qty > 0 ? "text-up" : "text-down"}`}>
                  {p.qty > 0 ? t("롱") : t("숏")} {Math.abs(p.qty)}
                </td>
                <td className="num text-right">{leverageLabel(p.symbol, p.leverage)}</td>
                <td className="num text-right">{fmtFuture(p.symbol, Math.round(p.avgPrice))}</td>
                <td className="num text-right">{fmtFuture(p.symbol, p.markPrice)}</td>
                <td className="num text-right">{won(p.marginHeld)}</td>
                <td className={`num text-right font-medium ${tone(p.unrealized)}`}>
                  {p.unrealized > 0 ? "+" : ""}
                  {won(p.unrealized)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={5} className="text-ink-muted">
                {t("합계")}
              </td>
              <td className="num text-right font-semibold">{won(totalMargin)}</td>
              <td className={`num text-right font-semibold ${tone(totalPnl)}`}>
                {totalPnl > 0 ? "+" : ""}
                {won(totalPnl)}
                {totalMargin > 0 && (
                  <span className="ml-1 text-xs opacity-80" title={t("증거금 대비")}>
                    ({totalPnl > 0 ? "+" : ""}
                    {((totalPnl / totalMargin) * 100).toFixed(2)}%)
                  </span>
                )}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}
