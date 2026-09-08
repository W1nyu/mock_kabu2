"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, fmt, getToken, getUser } from "@/lib/api";
import { formatKstTime, MARKET_TIME_ZONE_LABEL } from "@/lib/time";
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

/** Only terminal-negative and in-flight states earn a colour; the rest stay quiet. */
const STATUS_TONE: Record<string, string> = {
  FILLED: "chip-live",
  REJECTED: "chip-up",
  PARTIAL: "chip-down",
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
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">주문 내역</h1>
        <p className="mt-1 text-sm text-ink-muted">최근 100건의 주문을 실시간으로 반영합니다.</p>
      </div>

      <div className="glass overflow-hidden">
        <div className="overflow-x-auto">
          <table className="tbl tbl-hover">
            <thead>
              <tr>
                <th>시각 ({MARKET_TIME_ZONE_LABEL})</th>
                <th>종목</th>
                <th>구분</th>
                <th className="text-right">가격</th>
                <th className="text-right">체결/수량</th>
                <th className="text-right">상태</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <td className="num whitespace-nowrap text-ink-muted">
                    {formatKstTime(new Date(o.createdAt).getTime())}
                  </td>
                  <td className="font-semibold">{o.symbol}</td>
                  <td>
                    <span
                      className={`font-medium ${o.side === "BUY" ? "text-up" : "text-down"}`}
                    >
                      {o.side === "BUY" ? "매수" : "매도"}
                    </span>
                    <span className="ml-1.5 text-xs text-ink-faint">
                      {o.type === "LIMIT" ? "지정가" : "시장가"}
                    </span>
                  </td>
                  <td className="num text-right">
                    {o.price != null ? fmt.format(o.price) : "—"}
                  </td>
                  <td className="num text-right">
                    {fmt.format(o.filledQty)}
                    <span className="text-ink-faint">/{fmt.format(o.qty)}</span>
                  </td>
                  <td className="text-right">
                    <span className={`chip ${STATUS_TONE[o.status] ?? ""}`}>
                      {STATUS_LABEL[o.status] ?? o.status}
                    </span>
                  </td>
                </tr>
              ))}
              {orders.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-14 text-center text-sm text-ink-faint">
                    주문 내역이 없습니다
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
