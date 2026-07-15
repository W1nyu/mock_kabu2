"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, fmt, getToken, getUser } from "@/lib/api";
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
  createdAt: string;
}

const STATUS_LABEL: Record<string, string> = {
  OPEN: "접수",
  PARTIAL: "부분체결",
  FILLED: "체결완료",
  CANCELED: "취소",
  REJECTED: "거부",
};

export default function OrdersPage() {
  const router = useRouter();
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const load = useCallback(() => {
    api<OrderRow[]>("/orders?limit=100").then(setOrders).catch(() => {});
  }, []);

  useEffect(() => {
    if (!getToken()) {
      router.push("/login");
      return;
    }
    load();
    const user = getUser();
    const unsub = user ? subscribe([`account:${user.accountId}`], () => load()) : () => {};
    // Realtime account notifications normally update this immediately.
    const t = setInterval(load, 15_000);
    return () => {
      unsub();
      clearInterval(t);
    };
  }, [load, router]);

  return (
    <div>
      <h1 className="mb-4 text-xl font-bold">주문 내역</h1>
      <div className="overflow-hidden rounded-lg border border-neutral-800">
        <table className="w-full text-sm">
          <thead className="bg-neutral-900 text-left text-neutral-400">
            <tr>
              <th className="px-4 py-2">시각</th>
              <th className="px-4 py-2">종목</th>
              <th className="px-4 py-2">구분</th>
              <th className="px-4 py-2 text-right">가격</th>
              <th className="px-4 py-2 text-right">체결/수량</th>
              <th className="px-4 py-2">상태</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id} className="border-t border-neutral-800">
                <td className="px-4 py-2 text-neutral-400">
                  {new Date(o.createdAt).toLocaleTimeString("ko-KR", { hour12: false })}
                </td>
                <td className="px-4 py-2 font-semibold">{o.symbol}</td>
                <td className={`px-4 py-2 ${o.side === "BUY" ? "text-red-400" : "text-blue-400"}`}>
                  {o.side === "BUY" ? "매수" : "매도"}
                  <span className="ml-1 text-xs text-neutral-500">
                    {o.type === "LIMIT" ? "지정가" : "시장가"}
                  </span>
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {o.price != null ? fmt.format(o.price) : "—"}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {fmt.format(o.filledQty)}/{fmt.format(o.qty)}
                </td>
                <td className="px-4 py-2">{STATUS_LABEL[o.status] ?? o.status}</td>
              </tr>
            ))}
            {orders.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-neutral-500">
                  주문 내역이 없습니다
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
