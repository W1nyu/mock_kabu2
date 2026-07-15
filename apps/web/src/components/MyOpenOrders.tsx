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
    <div className="rounded-lg border border-neutral-800 bg-neutral-900">
      <div className="border-b border-neutral-800 px-3 py-2 text-xs font-semibold text-neutral-400">
        내 미체결 주문
      </div>
      <ul className="max-h-64 overflow-y-auto text-xs tabular-nums">
        {orders.map((o) => (
          <li key={o.id} className="flex items-center justify-between gap-2 px-3 py-1">
            <span className={o.side === "BUY" ? "text-red-400" : "text-blue-400"}>
              {o.side === "BUY" ? "매수" : "매도"}
            </span>
            <span className="text-neutral-300">{o.symbol}</span>
            <span>{o.price != null ? fmt.format(o.price) : "시장가"}</span>
            <span className="text-neutral-400">
              {fmt.format(o.filledQty)}/{fmt.format(o.qty)}
            </span>
            <button
              onClick={() => cancel(o.id)}
              className="rounded border border-neutral-700 px-2 py-0.5 text-neutral-400 hover:bg-neutral-800"
            >
              취소
            </button>
          </li>
        ))}
        {orders.length === 0 && <li className="px-3 py-2 text-neutral-500">미체결 주문 없음</li>}
      </ul>
    </div>
  );
}
