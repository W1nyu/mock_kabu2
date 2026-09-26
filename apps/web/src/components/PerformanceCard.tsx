"use client";

import { useEffect, useState } from "react";
import { api, fmt, getToken, won } from "@/lib/api";
import { drawdownOf, type Drawdown } from "@/lib/drawdown";
import { everyVisible } from "@/lib/visible-interval";

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

type Market = "all" | "stock" | "futures";
const MARKET_TABS: { id: Market; label: string }[] = [
  { id: "all", label: "전체" },
  { id: "stock", label: "주식" },
  { id: "futures", label: "선물·옵션" },
];

/**
 * 청산 체결 단위 성과 요약 — 승률·평균 손익·손익비·최고/최저 + 자산 추이의 최대 낙폭.
 * 주식(매도 체결)과 선물(청산·반대매매·일일 정산)을 탭으로 나눠 본다.
 */
export default function PerformanceCard({
  stats: stockStats,
  futuresStats = null,
  combinedStats = null,
}: {
  stats: RealizedStats | null;
  futuresStats?: RealizedStats | null;
  /** 주식 매도 체결 + 선물 청산 합산 */
  combinedStats?: RealizedStats | null;
}) {
  const [market, setMarket] = useState<Market>("all");
  const stats = market === "all" ? combinedStats : market === "stock" ? stockStats : futuresStats;
  const fillLabel = market === "stock" ? "매도 체결" : market === "futures" ? "청산" : "청산 체결";
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
    const t = everyVisible(load, 60_000);
    return () => {
      active = false;
      t();
    };
  }, [stockStats?.fills, futuresStats?.fills, combinedStats?.fills]);
  return (
    <section className="glass flex h-full flex-col overflow-hidden">
      <div className="panel-head">
        <span className="panel-title">매매 성과</span>
        <div className="flex items-center gap-2">
          {stats && stats.fills > 0 && (
            <span className="text-[11px] text-ink-faint">
              {fillLabel} {fmt.format(stats.fills)}건
            </span>
          )}
          <div className="well flex gap-0.5 p-0.5" role="group" aria-label="주식·선물">
            {MARKET_TABS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                aria-pressed={market === id}
                onClick={() => setMarket(id)}
                className={`rounded-lg px-2 py-0.5 text-[11px] font-medium transition-colors ${
                  market === id ? "bg-sky/15 text-sky ring-1 ring-inset ring-sky/35" : "text-ink-muted hover:text-ink"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
      {drawdown && (
        <dl className="num grid grid-cols-1 gap-x-4 border-b border-hairline-soft px-5 py-3 text-sm">
          <Stat
            label="최대 낙폭 (MDD)"
            value={`-${(drawdown.maxDrawdown * 100).toFixed(2)}%`}
            sub={`최고 자산 ${won(drawdown.peak)}`}
            tone={drawdown.maxDrawdown > 0.05 ? "down" : undefined}
            title="자산 추이에서 최고점 대비 가장 크게 내려간 비율"
          />
        </dl>
      )}
      {empty ? (
        <div className="grid flex-1 place-items-center px-5 py-10 text-center">
          <p className="text-sm text-ink-faint">
            {market === "futures"
              ? "아직 선물·옵션 청산이 없습니다. 포지션을 청산(또는 일일 정산·만기)하면 계산됩니다."
              : "아직 매도 체결이 없습니다. 첫 매도 뒤 승률과 손익비가 계산됩니다."}
          </p>
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
