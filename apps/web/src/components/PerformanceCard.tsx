"use client";

import { useEffect, useState } from "react";
import { api, fmt, getToken, won } from "@/lib/api";

export interface RealizedStats {
  fills: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  profitFactor: number | null;
  best: number | null;
  worst: number | null;
}

interface EquityPoint {
  ts: number;
  equity: number;
}

interface Drawdown {
  /** 최고 자산 대비 최대 낙폭 비율 (0~1) */
  maxDrawdown: number;
  peak: number;
  /** 현재 자산의 최고점 대비 낙폭 (0~1) */
  current: number;
}

/** 자산 추이 전체 구간에서 최고점 대비 최대 낙폭(MDD)과 현재 낙폭을 구한다. */
function drawdownOf(points: EquityPoint[]): Drawdown | null {
  if (points.length < 2) return null;
  let peak = points[0].equity;
  let maxDrawdown = 0;
  for (const p of points) {
    if (p.equity > peak) peak = p.equity;
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - p.equity) / peak);
  }
  const last = points[points.length - 1].equity;
  return { maxDrawdown, peak, current: peak > 0 ? Math.max(0, (peak - last) / peak) : 0 };
}

/** 매도 체결 단위 성과 요약 — 승률·평균 손익·손익비·최고/최저 + 자산 추이의 최대 낙폭. */
export default function PerformanceCard({ stats }: { stats: RealizedStats | null }) {
  const empty = !stats || stats.fills === 0;
  const [drawdown, setDrawdown] = useState<Drawdown | null>(null);

  useEffect(() => {
    if (!getToken()) return;
    let active = true;
    const load = () => {
      api<EquityPoint[]>("/account/equity?range=all")
        .then((points) => {
          if (active) setDrawdown(drawdownOf(points));
        })
        .catch(() => {});
    };
    load();
    const t = window.setInterval(load, 60_000);
    return () => {
      active = false;
      window.clearInterval(t);
    };
  }, [stats?.fills]);
  return (
    <section className="glass flex h-full flex-col overflow-hidden">
      <div className="panel-head">
        <span className="panel-title">매매 성과</span>
        {stats && stats.fills > 0 && (
          <span className="text-[11px] text-ink-faint">매도 체결 {fmt.format(stats.fills)}건</span>
        )}
      </div>
      {drawdown && (
        <dl className="num grid grid-cols-2 gap-x-4 border-b border-hairline-soft px-5 py-3 text-sm">
          <Stat
            label="최대 낙폭 (MDD)"
            value={`-${(drawdown.maxDrawdown * 100).toFixed(2)}%`}
            sub={`최고 자산 ${won(drawdown.peak)}`}
            tone={drawdown.maxDrawdown > 0.05 ? "down" : undefined}
            title="자산 추이에서 최고점 대비 가장 크게 내려간 비율"
          />
          <Stat
            label="현재 낙폭"
            value={drawdown.current > 0 ? `-${(drawdown.current * 100).toFixed(2)}%` : "고점"}
            tone={drawdown.current > 0 ? "down" : "up"}
            title="지금 자산이 최고 자산에서 얼마나 내려와 있는지"
          />
        </dl>
      )}
      {empty ? (
        <div className="grid flex-1 place-items-center px-5 py-10 text-center">
          <p className="text-sm text-ink-faint">아직 매도 체결이 없습니다. 첫 매도 뒤 승률과 손익비가 계산됩니다.</p>
        </div>
      ) : null}
      {!empty && (
        <dl className="num grid flex-1 grid-cols-2 gap-x-4 gap-y-4 px-5 py-4 text-sm">
          <Stat
            label="승률"
            value={stats.winRate != null ? `${(stats.winRate * 100).toFixed(1)}%` : "—"}
            sub={`${stats.wins}승 ${stats.losses}패`}
            tone={stats.winRate == null ? undefined : stats.winRate >= 0.5 ? "up" : "down"}
            title="손익이 0이 아닌 매도 체결 중 이익 체결의 비율"
          />
          <Stat
            label="손익비"
            value={stats.profitFactor != null ? stats.profitFactor.toFixed(2) : "—"}
            sub="총이익 ÷ 총손실"
            tone={stats.profitFactor == null ? undefined : stats.profitFactor >= 1 ? "up" : "down"}
            title="1보다 크면 잃은 돈보다 번 돈이 많습니다"
          />
          <Stat
            label="평균 이익"
            value={stats.avgWin != null ? `+${won(Math.round(stats.avgWin))}` : "—"}
            tone="up"
            title="이익 체결 한 건의 평균 실현손익"
          />
          <Stat
            label="평균 손실"
            value={stats.avgLoss != null ? `-${won(Math.round(stats.avgLoss))}` : "—"}
            tone="down"
            title="손실 체결 한 건의 평균 실현손실"
          />
          <Stat
            label="최고 체결"
            value={stats.best != null ? `${stats.best > 0 ? "+" : ""}${won(stats.best)}` : "—"}
            tone={stats.best != null && stats.best > 0 ? "up" : undefined}
            title="실현손익이 가장 큰 매도 체결"
          />
          <Stat
            label="최저 체결"
            value={stats.worst != null ? `${stats.worst > 0 ? "+" : ""}${won(stats.worst)}` : "—"}
            tone={stats.worst != null && stats.worst < 0 ? "down" : undefined}
            title="실현손익이 가장 작은 매도 체결"
          />
        </dl>
      )}
    </section>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
  title,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "up" | "down";
  title: string;
}) {
  const color = tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-ink";
  return (
    <div title={title}>
      <dt className="text-[11px] tracking-wide text-ink-muted uppercase">{label}</dt>
      <dd className={`mt-1 font-semibold ${color}`}>{value}</dd>
      {sub && <dd className="text-[11px] text-ink-faint">{sub}</dd>}
    </div>
  );
}
