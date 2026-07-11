"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

interface LockCounters {
  strategy: string;
  invocations: number;
  attempts: number;
  conflicts: number;
  retries: number;
  failures: number;
}

const STRATEGY_LABEL: Record<string, string> = {
  optimistic: "낙관적 락 (version 컬럼 + 재시도)",
  pessimistic: "비관적 락 (SELECT ... FOR UPDATE)",
  distributed: "Redis 분산 락 (SET NX + fencing token)",
};

/** 동시성 실험 관전 모드 (스펙 §6) */
export default function AdminPage() {
  const [counters, setCounters] = useState<LockCounters | null>(null);
  const [history, setHistory] = useState<{ ts: number; invocations: number }[]>([]);

  useEffect(() => {
    const load = () =>
      api<LockCounters>("/admin/lock-info", { auth: false })
        .then((c) => {
          setCounters(c);
          setHistory((prev) => [...prev, { ts: Date.now(), invocations: c.invocations }].slice(-30));
        })
        .catch(() => {});
    load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, []);

  // 최근 2초 간격 invocation 증가량 → 대략적인 TPS
  const tps =
    history.length >= 2
      ? Math.max(
          0,
          ((history[history.length - 1].invocations - history[history.length - 2].invocations) /
            (history[history.length - 1].ts - history[history.length - 2].ts)) *
            1000,
        )
      : 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">동시성 실험 관전 모드</h1>
        <p className="mt-1 text-sm text-neutral-400">
          잔액/보유자산 변경(주문 홀드·이체·정산)이 통과하는 락 계층의 실시간 상태입니다. api의{" "}
          <code className="rounded bg-neutral-800 px-1">LOCK_STRATEGY</code> 환경변수로 전략을
          바꿔 재기동하면 여기서 확인할 수 있습니다.
        </p>
      </div>

      <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
        <p className="text-xs text-neutral-400">현재 락 전략</p>
        <p className="mt-1 text-lg font-bold text-amber-400">
          {counters ? (STRATEGY_LABEL[counters.strategy] ?? counters.strategy) : "…"}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        <Stat label="총 호출" value={counters?.invocations ?? 0} />
        <Stat label="트랜잭션 시도" value={counters?.attempts ?? 0} />
        <Stat label="충돌 감지" value={counters?.conflicts ?? 0} warn={(counters?.conflicts ?? 0) > 0} />
        <Stat label="재시도" value={counters?.retries ?? 0} warn={(counters?.retries ?? 0) > 0} />
        <Stat label="최종 실패" value={counters?.failures ?? 0} warn={(counters?.failures ?? 0) > 0} />
      </div>

      <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
        <p className="text-xs text-neutral-400">임계 구역 처리율 (근사)</p>
        <p className="mt-1 text-2xl font-bold tabular-nums">
          {tps.toFixed(1)} <span className="text-sm font-normal text-neutral-400">locks/s</span>
        </p>
      </div>
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <p className="text-xs text-neutral-400">{label}</p>
      <p className={`mt-1 text-lg font-bold tabular-nums ${warn ? "text-amber-400" : ""}`}>
        {new Intl.NumberFormat("ko-KR").format(value)}
      </p>
    </div>
  );
}
