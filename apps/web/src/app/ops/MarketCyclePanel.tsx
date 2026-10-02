"use client";

import { useEffect, useState } from "react";
import {
  MACRO_CYCLE_DRIVERS,
  type MacroCycleDriver,
  type MacroCyclePhase,
  type MarketCyclePhase,
  type MarketCycleReport,
} from "@mock-kabu/shared";
import { api } from "@/lib/api";
import { formatKstHm, formatKstMonthDay, MARKET_TIME_ZONE_LABEL } from "@/lib/time";

const MARKET_PHASE: Record<MarketCyclePhase, { label: string; className: string }> = {
  BULL: { label: "상승장", className: "chip chip-up" },
  BEAR: { label: "하락장", className: "chip chip-down" },
  SIDEWAYS: { label: "횡보장", className: "chip" },
};

const DRIVER_NAME: Record<MacroCycleDriver, string> = { RATE: "금리", FX: "환율", OIL: "유가", COMMODITY: "원자재" };

const DRIVER_PHASE: Record<MacroCycleDriver, Record<MacroCyclePhase, string>> = {
  RATE: { RISING: "인상기", FALLING: "인하기", STEADY: "동결기" },
  FX: { RISING: "상승기 (원화 약세)", FALLING: "하락기 (원화 강세)", STEADY: "안정기" },
  OIL: { RISING: "상승기", FALLING: "하락기", STEADY: "안정기" },
  COMMODITY: { RISING: "강세기", FALLING: "약세기", STEADY: "보합기" },
};

/** 봇 보고가 이보다 오래되면 봇이 멈춘 것 */
const STALE_MS = 3 * 60_000;

function since(ms: number): string {
  return `${formatKstMonthDay(ms)} ${formatKstHm(ms)}`;
}

function signed(value: number): string {
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(2)}`;
}

/**
 * 관리자 전용: 봇이 스스로 돌리는 자동 장세의 지금 국면. 언제 다음 국면으로 넘어가는지는
 * 봇만 알고 여기에도 오지 않는다.
 */
export function MarketCyclePanel() {
  const [report, setReport] = useState<MarketCycleReport | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const load = () =>
      api<{ report: MarketCycleReport | null }>("/admin/market-cycle")
        .then((body) => setReport(body.report))
        .catch(() => {})
        .finally(() => {
          setLoaded(true);
          setNow(Date.now());
        });
    load();
    const timer = window.setInterval(load, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const stale = report != null && now - report.reportedAtMs > STALE_MS;
  const phase = report ? MARKET_PHASE[report.market.phase] : null;

  return (
    <section className="glass space-y-3 p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold tracking-tight">자동 장세</h2>
        {report && (
          <span className={`num text-xs ${stale ? "text-up" : "text-ink-muted"}`}>
            {stale ? "봇 보고 끊김 · " : ""}
            {formatKstHm(report.reportedAtMs)} 보고
          </span>
        )}
      </div>

      {!report ? (
        <p className="text-sm text-ink-muted">
          {loaded ? "아직 봇 보고가 없습니다 (봇 기동 후 1분 안에 들어옵니다)" : "불러오는 중…"}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {phase && <span className={phase.className}>{phase.label}</span>}
            <span className="num text-sm text-ink-muted">
              {since(report.market.sinceMs)} {MARKET_TIME_ZONE_LABEL}부터
            </span>
          </div>
          <p className="text-sm">
            종목 기사 호재 비율 약{" "}
            <span className="num font-semibold">{Math.round(report.market.positiveShare * 100)}%</span>
            <span className="num text-ink-muted">
              {" "}
              · 기울기 {signed(report.market.lean)} (사이클 {signed(report.market.cycleLean)}, 지수 보정{" "}
              {signed(report.valuation.pull)})
            </span>
          </p>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            {MACRO_CYCLE_DRIVERS.map((driver) => {
              const state = report.drivers[driver];
              return (
                <div key={driver}>
                  <dt className="text-xs text-ink-muted">{DRIVER_NAME[driver]}</dt>
                  <dd>
                    {DRIVER_PHASE[driver][state.phase]}{" "}
                    <span className="num text-xs text-ink-faint">{since(state.sinceMs)}~</span>
                  </dd>
                </div>
              );
            })}
          </dl>
          <p className="num text-xs text-ink-muted">
            지수 {report.valuation.index?.toLocaleString("ko-KR", { maximumFractionDigits: 2 }) ?? "—"} · 적정{" "}
            {report.valuation.fairIndex.toLocaleString("ko-KR", { maximumFractionDigits: 2 })}
          </p>
        </>
      )}

      <p className="text-xs text-ink-muted">
        봇이 상승장·하락장·횡보장과 금리·환율·유가·원자재 사이클을 스스로 돌리며, 국면에 따라 호재/악재 비율과 시장
        기사 종류·빈도·주문 쏠림이 바뀝니다. 지수가 적정 수준에서 많이 벗어나면 반대쪽으로 약하게 당깁니다. 다음
        국면이 언제 오는지는 여기에도 나오지 않습니다. 아래 시나리오는 이 위에 더해집니다.
      </p>
    </section>
  );
}
