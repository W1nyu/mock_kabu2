"use client";

import { useEffect, useState } from "react";
import { api, getToken, won } from "@/lib/api";

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

/** 사용자 계정 수익률 랭킹. 봇은 제외되며, 내 순위는 상위 밖이어도 마지막 줄에 붙는다. */
export default function Leaderboard({ refreshKey }: { refreshKey?: number }) {
  const [board, setBoard] = useState<LeaderboardDto | null>(null);

  useEffect(() => {
    if (!getToken()) return;
    let active = true;
    const load = () => {
      api<LeaderboardDto>("/account/leaderboard?limit=10")
        .then((data) => {
          if (active) setBoard(data);
        })
        .catch(() => {});
    };
    load();
    const t = window.setInterval(load, REFRESH_MS);
    return () => {
      active = false;
      window.clearInterval(t);
    };
  }, [refreshKey]);

  return (
    <section className="glass overflow-hidden">
      <div className="panel-head">
        <span className="panel-title">투자자 랭킹</span>
        {board && (
          <span className="text-[11px] text-ink-faint" title="봇 계정은 제외됩니다">
            {board.total}명 · 순입금 대비 수익률
          </span>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="tbl tbl-hover">
          <thead>
            <tr>
              <th className="w-12">순위</th>
              <th>투자자</th>
              <th className="text-right">총 자산</th>
              <th className="text-right" title="(총 자산 − 순입금) ÷ 순입금">
                수익률
              </th>
              <th className="text-right" title="매도 체결에서 확정된 손익 합계">
                실현손익
              </th>
            </tr>
          </thead>
          <tbody>
            {board?.rows.map((row) => {
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
                    {row.me && <span className="chip chip-live ml-2">나</span>}
                  </td>
                  <td className="num text-right">{won(row.equity)}</td>
                  <td className={`num text-right font-medium ${tone}`}>
                    {row.returnRate == null
                      ? "—"
                      : `${row.returnRate > 0 ? "+" : ""}${(row.returnRate * 100).toFixed(2)}%`}
                  </td>
                  <td
                    className={`num text-right ${
                      row.realized > 0 ? "text-up" : row.realized < 0 ? "text-down" : "text-ink-faint"
                    }`}
                  >
                    {row.realized > 0 ? "+" : ""}
                    {won(row.realized)}
                  </td>
                </tr>
              );
            })}
            {(!board || board.rows.length === 0) && (
              <tr>
                <td colSpan={5} className="py-10 text-center text-sm text-ink-faint">
                  {board ? "아직 투자자가 없습니다" : "랭킹을 불러오는 중…"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
