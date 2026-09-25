"use client";

import { useEffect, useState } from "react";
import { api, fmt, getToken, won } from "@/lib/api";
import { everyVisible } from "@/lib/visible-interval";

interface DailyRow {
  date: string;
  closeEquity: number | null;
  closeCash: number | null;
  change: number | null;
  changeRate: number | null;
  realized: number;
  fills: number;
}

const DAYS = 14;
const REFRESH_MS = 60_000;

const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"];

function labelOf(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const weekday = WEEKDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${m}/${d} (${weekday})`;
}

function signed(n: number): string {
  return `${n > 0 ? "+" : ""}${won(n)}`;
}

/** KST 일별 성과 — 종가 자산, 전일 대비, 실현손익. 오늘 행은 아직 열려 있는 날이다. */
export default function DailyPerformance({ refreshKey }: { refreshKey?: number }) {
  const [rows, setRows] = useState<DailyRow[] | null>(null);

  useEffect(() => {
    if (!getToken()) return;
    let active = true;
    const load = () => {
      api<DailyRow[]>(`/account/daily?days=${DAYS}`)
        .then((data) => {
          if (active) setRows(data);
        })
        .catch(() => {});
    };
    load();
    const t = everyVisible(load, REFRESH_MS);
    return () => {
      active = false;
      t();
    };
  }, [refreshKey]);

  return (
    <section className="glass flex h-full flex-col overflow-hidden">
      <div className="panel-head">
        <span className="panel-title">일별 성과</span>
        <span className="text-[11px] text-ink-faint">KST · 최근 {DAYS}일</span>
      </div>
      <div className="overflow-x-auto">
        <table className="tbl tbl-hover">
          <thead>
            <tr>
              <th>날짜</th>
              <th className="text-right" title="그날 마지막 스냅샷의 총 자산">
                종가 자산
              </th>
              <th className="text-right" title="전일 종가 자산 대비">
                전일 대비
              </th>
              <th className="text-right" title="그날 매도 체결에서 확정된 손익">
                실현손익
              </th>
            </tr>
          </thead>
          <tbody>
            {rows?.map((r, index) => {
              const changeTone =
                r.change == null || r.change === 0 ? "text-ink-muted" : r.change > 0 ? "text-up" : "text-down";
              const realizedTone = r.realized > 0 ? "text-up" : r.realized < 0 ? "text-down" : "text-ink-faint";
              return (
                <tr key={r.date}>
                  <td className="num whitespace-nowrap">
                    {labelOf(r.date)}
                    {index === 0 && <span className="chip chip-live ml-2">오늘</span>}
                  </td>
                  <td className="num text-right">{r.closeEquity != null ? won(r.closeEquity) : "—"}</td>
                  <td className={`num text-right ${changeTone}`}>
                    {r.change == null
                      ? "—"
                      : `${signed(r.change)}${
                          r.changeRate != null ? ` (${r.changeRate > 0 ? "+" : ""}${(r.changeRate * 100).toFixed(2)}%)` : ""
                        }`}
                  </td>
                  <td className={`num text-right ${realizedTone}`}>
                    {r.fills > 0 ? (
                      <>
                        {signed(r.realized)}
                        <span className="ml-1 text-[11px] text-ink-faint">{fmt.format(r.fills)}건</span>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              );
            })}
            {(!rows || rows.length === 0) && (
              <tr>
                <td colSpan={4} className="py-10 text-center text-sm text-ink-faint">
                  {rows ? "아직 기록된 날이 없습니다" : "불러오는 중…"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
