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

export default function TradesFeed({ symbol }: { symbol: string }) {
  const [ticks, setTicks] = useState<Tick[]>([]);

  useEffect(() => {
    api<{ id: string; price: number; qty: number; takerSide: "BUY" | "SELL"; createdAt: string }[]>(
      `/market/trades/${symbol}?limit=30`,
      { auth: false },
    )
      .then((rows) =>
        setTicks(
          rows.map((r) => ({
            tradeId: r.id,
            price: r.price,
            qty: r.qty,
            takerSide: r.takerSide,
            ts: new Date(r.createdAt).getTime(),
          })),
        ),
      )
      .catch(() => {});

    return subscribe([`trades:${symbol}`], ({ data }) => {
      // 재연결 직후 등 같은 체결이 중복 수신되면 무시 (key 중복 방지)
      setTicks((prev) =>
        prev[0]?.tradeId === data.tradeId ? prev : [data as Tick, ...prev].slice(0, 30),
      );
    });
  }, [symbol]);

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900">
      <div className="border-b border-neutral-800 px-3 py-2 text-xs font-semibold text-neutral-400">
        실시간 체결
      </div>
      <ul className="max-h-64 overflow-y-auto text-xs tabular-nums">
        {ticks.map((t) => (
          <li key={t.tradeId} className="flex justify-between px-3 py-0.5">
            <span className={t.takerSide === "BUY" ? "text-red-400" : "text-blue-400"}>
              {fmt.format(t.price)}
            </span>
            <span className="text-neutral-300">{fmt.format(t.qty)}</span>
            <span className="text-neutral-500">
              {new Date(t.ts).toLocaleTimeString("ko-KR", { hour12: false })}
            </span>
          </li>
        ))}
        {ticks.length === 0 && <li className="px-3 py-2 text-neutral-500">체결 대기중…</li>}
      </ul>
    </div>
  );
}
