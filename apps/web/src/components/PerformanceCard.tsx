"use client";

import { fmt, won } from "@/lib/api";

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

/** 매도 체결 단위 성과 요약 — 승률·평균 손익·손익비·최고/최저. 실현손익 테이블에서 계산. */
export default function PerformanceCard({ stats }: { stats: RealizedStats | null }) {
  const empty = !stats || stats.fills === 0;
  return (
    <section className="glass flex h-full flex-col overflow-hidden">
      <div className="panel-head">
        <span className="panel-title">매매 성과</span>
        {stats && stats.fills > 0 && (
          <span className="text-[11px] text-ink-faint">매도 체결 {fmt.format(stats.fills)}건</span>
        )}
      </div>
      {empty ? (
        <div className="grid flex-1 place-items-center px-5 py-10 text-center">
          <p className="text-sm text-ink-faint">아직 매도 체결이 없습니다. 첫 매도 뒤 승률과 손익비가 계산됩니다.</p>
        </div>
      ) : (
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
