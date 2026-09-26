"use client";

import { useEffect, useState } from "react";
import { api, fmt } from "@/lib/api";
import { formatKstTime, MARKET_TIME_ZONE_LABEL } from "@/lib/time";
import { subscribe } from "@/lib/socket";
import { useT } from "@/lib/i18n";

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

export default function TradesFeed({ symbol }: { symbol: string }) {
  const tr = useT();
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
    <div className="glass flex flex-col overflow-hidden">
      <div className="panel-head">
        <span className="panel-title">{tr("실시간 체결")}</span>
        <span className="chip chip-live">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ok" />
          LIVE
        </span>
      </div>
      <div
        className={`grid ${tradeGridColumns} gap-x-2 border-b border-hairline-soft px-4 py-1.5 text-[10px] font-semibold tracking-wide text-ink-faint uppercase`}
      >
        <span>{tr("가격")}</span>
        <span className="text-right">{tr("수량")}</span>
        <span className="justify-self-end">{tr("시각")} ({MARKET_TIME_ZONE_LABEL})</span>
      </div>
      <ul className="num max-h-72 flex-1 overflow-y-auto text-xs">
        {ticks.map((t) => (
          <li
            key={t.tradeId}
            className={`grid ${tradeGridColumns} items-center gap-x-2 px-4 py-1 transition-colors hover:bg-surface-3/30`}
          >
            <span className={`font-medium ${t.takerSide === "BUY" ? "text-up" : "text-down"}`}>
              {fmt.format(t.price)}
            </span>
            <span className="justify-self-end text-ink-muted">{fmt.format(t.qty)}</span>
            <span className="justify-self-end whitespace-nowrap text-ink-faint">
              {formatKstTime(t.ts)}
            </span>
          </li>
        ))}
        {ticks.length === 0 && (
          <li className="px-4 py-8 text-center text-ink-faint">{tr("체결 대기중…")}</li>
        )}
      </ul>
    </div>
  );
}
