"use client";

import { useEffect, useState } from "react";
import { api, fmt } from "@/lib/api";
import { subscribe } from "@/lib/socket";

interface Tick {
  tradeId: string;
  price: number;
  qty: number;
  takerSide: "BUY" | "SELL";
  ts: number;
}

interface TradeRow {
  id: string;
  price: number;
  qty: number;
  takerSide: "BUY" | "SELL";
  createdAt: string;
}

const tradeGridColumns = "grid-cols-[7rem_3.5rem_minmax(0,1fr)]";
const MAX_TICKS = 30;

/** REST 스냅샷과 재전송될 수 있는 실시간 체결을 합쳐도 tradeId는 한 번만 유지한다. */
function mergeTicks(...sources: Tick[][]): Tick[] {
  const seen = new Set<string>();

  return sources
    .flat()
    .filter((tick) => {
      if (seen.has(tick.tradeId)) return false;
      seen.add(tick.tradeId);
      return true;
    })
    .sort((left, right) => right.ts - left.ts)
    .slice(0, MAX_TICKS);
}

function toSnapshotTick(row: TradeRow): Tick {
  return {
    tradeId: row.id,
    price: row.price,
    qty: row.qty,
    takerSide: row.takerSide,
    ts: new Date(row.createdAt).getTime(),
  };
}

function parseLiveTick(data: unknown): Tick | null {
  if (!data || typeof data !== "object") return null;
  const tick = data as Partial<Tick>;

  if (
    typeof tick.tradeId !== "string" ||
    tick.tradeId.length === 0 ||
    !Number.isFinite(tick.price) ||
    !Number.isFinite(tick.qty) ||
    !Number.isFinite(tick.ts) ||
    (tick.takerSide !== "BUY" && tick.takerSide !== "SELL")
  ) {
    return null;
  }

  return tick as Tick;
}

/** 항상 같은 폭의 HH:mm:ss로 만들어 체결 행의 열 정렬을 유지한다. */
function formatTradeTime(ts: number) {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "--:--:--";

  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}

export default function TradesFeed({ symbol }: { symbol: string }) {
  const [ticks, setTicks] = useState<Tick[]>([]);

  useEffect(() => {
    let active = true;
    setTicks([]);

    const unsubscribe = subscribe([`trades:${symbol}`], ({ data }) => {
      const tick = parseLiveTick(data);
      if (!tick) return;

      // outbox 재시도나 재연결로 같은 체결이 다시 오더라도 key가 중복되지 않게 한다.
      setTicks((previous) => mergeTicks([tick], previous));
    });

    api<TradeRow[]>(`/market/trades/${symbol}?limit=${MAX_TICKS}`, { auth: false })
      .then((rows) => {
        if (!active) return;
        // REST 요청과 소켓 수신이 겹칠 수 있으므로 기존 실시간 체결과 병합한다.
        setTicks((previous) => mergeTicks(previous, rows.map(toSnapshotTick)));
      })
      .catch(() => {});

    return () => {
      active = false;
      unsubscribe();
    };
  }, [symbol]);

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900">
      <div className="border-b border-neutral-800 px-3 py-2 text-xs font-semibold text-neutral-400">
        실시간 체결
      </div>
      <div
        className={`grid ${tradeGridColumns} gap-x-2 border-b border-neutral-800 px-3 py-1.5 text-[11px] font-medium text-neutral-500`}
      >
        <span>가격</span>
        <span className="text-right">수량</span>
        <span className="justify-self-end">일시</span>
      </div>
      <ul className="max-h-64 overflow-y-auto text-xs tabular-nums">
        {ticks.map((t) => (
          <li
            key={t.tradeId}
            className={`grid ${tradeGridColumns} items-center gap-x-2 px-3 py-0.5`}
          >
            <span className={t.takerSide === "BUY" ? "text-red-400" : "text-blue-400"}>
              {fmt.format(t.price)}
            </span>
            <span className="justify-self-end text-neutral-300">{fmt.format(t.qty)}</span>
            <span className="justify-self-end whitespace-nowrap text-neutral-500">{formatTradeTime(t.ts)}</span>
          </li>
        ))}
        {ticks.length === 0 && <li className="px-3 py-2 text-neutral-500">체결 대기중…</li>}
      </ul>
    </div>
  );
}
