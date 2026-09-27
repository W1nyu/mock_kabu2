"use client";

import { useEffect, useState } from "react";
import { api, getToken, getUser, won } from "@/lib/api";
import { readSnapshot, SNAPSHOT_MAX_AGE_MS, writeSnapshot } from "@/lib/snapshot";
import { everyVisible } from "@/lib/visible-interval";
import { useT } from "@/lib/i18n";

interface LeaderRow {
  rank: number;
  accountId: string;
  nickname: string;
  equity: number;
  deposits: number;
  pnl: number;
  returnRate: number | null;
  realized: number;
  me: boolean;
}

interface LeaderboardDto {
  total: number;
  rows: LeaderRow[];
}

const REFRESH_MS = 30_000;
/** 기본으로 보여 줄 상위 등수 */
const DEFAULT_TOP_N = 10;

type Period = "all" | "today" | "week";
const PERIODS: { id: Period; label: string; hint: string }[] = [
  { id: "today", label: "오늘", hint: "KST 오늘 첫 스냅샷 대비" },
  { id: "week", label: "1주", hint: "최근 7일 첫 스냅샷 대비" },
  { id: "all", label: "전체", hint: "가입 이후 순입금 대비" },
];
const PERIOD_STORAGE_KEY = "dashboard:leaderboard-period";

/** 사용자 계정 수익률 랭킹(상위 topN). 봇은 제외된다. */
export default function Leaderboard({ refreshKey, topN = DEFAULT_TOP_N }: { refreshKey?: number; topN?: number }) {
  const tr = useT();
  const [board, setBoard] = useState<LeaderboardDto | null>(null);
  const [period, setPeriod] = useState<Period>("all");

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(PERIOD_STORAGE_KEY);
      if (saved === "today" || saved === "week" || saved === "all") setPeriod(saved);
    } catch {
      // ignore
    }
  }, []);

  function selectPeriod(next: Period) {
    setPeriod(next);
    setBoard(null);
    try {
      window.localStorage.setItem(PERIOD_STORAGE_KEY, next);
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    if (!getToken()) return;
    let active = true;
    // 순위표에는 내 행 표시가 있어 계정별로 따로 보관한다. 다시 열거나 기간을 바꿀 때 이전 순위를 먼저 그린다.
    const snapKey = `leaderboard:${getUser()?.accountId ?? "-"}:${period}:${topN}`;
    const cached = readSnapshot<LeaderboardDto>(snapKey, SNAPSHOT_MAX_AGE_MS);
    if (cached) setBoard((prev) => prev ?? cached);
    const load = () => {
      api<LeaderboardDto>(`/account/leaderboard?limit=${topN}&period=${period}`)
        .then((data) => {
          if (!active) return;
          setBoard(data);
          writeSnapshot(snapKey, data);
        })
        .catch(() => {});
    };
    load();
    const t = everyVisible(load, REFRESH_MS);
    return () => {
      active = false;
      t();
    };
  }, [refreshKey, period, topN]);

  // API는 순위 밖이어도 내 행을 덧붙이지만, 랭킹은 상위 topN만 보여 준다.
  const topRows = board?.rows.filter((row) => row.rank <= topN) ?? [];

  return (
    <section className="glass overflow-hidden">
      <div className="panel-head flex-wrap gap-y-2">
        <span className="panel-title">
          {tr("투자자 랭킹")}
          {board && (
            <span className="ml-2 font-normal text-ink-faint" title={tr("봇 계정은 제외됩니다")}>
              {tr("{n}명", { n: board.total })}
            </span>
          )}
        </span>
        <div className="well flex gap-0.5 p-0.5" role="group" aria-label={tr("랭킹 기간")}>
          {PERIODS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => selectPeriod(p.id)}
              aria-pressed={period === p.id}
              title={tr(p.hint)}
              className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                period === p.id
                  ? "bg-sky/15 text-sky ring-1 ring-inset ring-sky/35"
                  : "text-ink-muted hover:bg-surface-3/45 hover:text-ink"
              }`}
            >
              {tr(p.label)}
            </button>
          ))}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="tbl tbl-hover">
          <thead>
            <tr>
              <th className="w-12">{tr("순위")}</th>
              <th>{tr("투자자")}</th>
              <th className="text-right">{tr("총 자산")}</th>
              <th
                className="text-right"
                title={period === "all" ? tr("(총 자산 − 순입금) ÷ 순입금") : tr("기간 시작 자산 대비 (기간 중 입출금 제외)")}
              >
                {tr("수익률")}
              </th>
              <th className="hidden text-right sm:table-cell" title={tr("매도 체결에서 확정된 손익 합계")}>
                {tr("실현손익")}
              </th>
            </tr>
          </thead>
          <tbody>
            {topRows.map((row) => {
              const tone =
                row.pnl > 0 ? "text-up" : row.pnl < 0 ? "text-down" : "text-ink-muted";
              return (
                <tr key={row.accountId} className={row.me ? "bg-sky/6" : undefined}>
                  <td className="num text-ink-muted">
                    {row.rank <= 3 ? (
                      <span className={`font-semibold ${row.rank === 1 ? "text-warn" : "text-ink"}`}>
                        {row.rank}
                      </span>
                    ) : (
                      row.rank
                    )}
                  </td>
                  <td className="font-semibold">
                    {row.nickname}
                    {row.me && <span className="chip chip-live ml-2">{tr("나")}</span>}
                  </td>
                  <td className="num text-right">{won(row.equity)}</td>
                  <td className={`num text-right font-medium ${tone}`}>
                    {row.returnRate == null
                      ? "—"
                      : `${row.returnRate > 0 ? "+" : ""}${(row.returnRate * 100).toFixed(2)}%`}
                  </td>
                  <td
                    className={`num hidden text-right sm:table-cell ${
                      row.realized > 0 ? "text-up" : row.realized < 0 ? "text-down" : "text-ink-faint"
                    }`}
                  >
                    {row.realized > 0 ? "+" : ""}
                    {won(row.realized)}
                  </td>
                </tr>
              );
            })}
            {(!board || topRows.length === 0) && (
              <tr>
                <td colSpan={5} className="py-10 text-center text-sm text-ink-faint">
                  {board ? tr("아직 투자자가 없습니다") : tr("랭킹을 불러오는 중…")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
