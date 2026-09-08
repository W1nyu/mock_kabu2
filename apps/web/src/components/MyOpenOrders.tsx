"use client";

import { useCallback, useEffect, useState } from "react";
import { api, fmt, getUser } from "@/lib/api";
import { subscribe } from "@/lib/socket";

interface OrderRow {
  id: string;
  symbol: string;
  side: "BUY" | "SELL";
  type: string;
  price: number | null;
  qty: number;
  filledQty: number;
  status: string;
}

export default function MyOpenOrders({
  symbol,
  refreshKey,
}: {
  symbol?: string;
  /** Bumps immediately after this page successfully accepts an order. */
  refreshKey?: number;
}) {
  const [orders, setOrders] = useState<OrderRow[]>([]);

  const refresh = useCallback(() => {
    api<OrderRow[]>("/orders?limit=100")
      .then((rows) =>
        setOrders(
          rows.filter(
            (o) =>
              ["OPEN", "PARTIAL"].includes(o.status) && (!symbol || o.symbol === symbol),
          ),
        ),
      )
      .catch(() => {});
  }, [symbol]);

  useEffect(() => {
    refresh();
  }, [refresh, refreshKey]);

  useEffect(() => {
    const user = getUser();
    const unsub = user ? subscribe([`account:${user.accountId}`], () => refresh()) : () => {};
    // Account pushes and the order form's direct refresh are the normal path.
    // Keep a light fallback for a reconnect that missed both.
    const t = setInterval(refresh, 15_000);
    return () => {
      unsub();
      clearInterval(t);
    };
  }, [refresh]);

  async function cancel(id: string) {
    try {
      await api(`/orders/${id}`, { method: "DELETE" });
      refresh();
    } catch {
      // 이미 체결된 경우 등 — 새로고침으로 상태 반영
      refresh();
    }
  }

  return (
    <div className="glass flex flex-col overflow-hidden">
      <div className="panel-head">
        <span className="panel-title">내 미체결 주문</span>
        {orders.length > 0 && <span className="chip">{orders.length}</span>}
      </div>
      <ul className="num max-h-72 flex-1 overflow-y-auto text-xs">
        {orders.map((o) => {
          const pct = o.qty > 0 ? (o.filledQty / o.qty) * 100 : 0;
          return (
            <li
              key={o.id}
              className="relative flex items-center gap-2 border-b border-hairline-soft px-4 py-2 last:border-b-0"
            >
              {/* Fill progress reads as a quiet bar under the row. */}
              <span
                className="absolute inset-y-0 left-0 bg-white/4"
                style={{ width: `${pct}%` }}
                aria-hidden
              />
              <span
                className={`relative w-8 shrink-0 font-semibold ${o.side === "BUY" ? "text-up" : "text-down"}`}
              >
                {o.side === "BUY" ? "매수" : "매도"}
              </span>
              <span className="relative shrink-0 font-medium">{o.symbol}</span>
              <span className="relative ml-auto text-ink-muted">
                {o.price != null ? fmt.format(o.price) : "시장가"}
              </span>
              <span className="relative w-16 shrink-0 text-right text-ink-faint">
                {fmt.format(o.filledQty)}/{fmt.format(o.qty)}
              </span>
              <button
                onClick={() => cancel(o.id)}
                className="btn btn-ghost btn-sm relative shrink-0"
              >
                취소
              </button>
            </li>
          );
        })}
        {orders.length === 0 && (
          <li className="px-4 py-8 text-center text-ink-faint">미체결 주문 없음</li>
        )}
      </ul>
    </div>
  );
}
