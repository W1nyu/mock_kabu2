"use client";

import { isOnTick, tickSizeOf } from "@mock-kabu/shared";
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
  // 정정 중인 주문: 인라인으로 가격/남은 수량을 고쳐 취소+재접수한다.
  const [editing, setEditing] = useState<{ id: string; price: string; qty: string } | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

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

  function startEdit(o: OrderRow) {
    setEditing({ id: o.id, price: String(o.price ?? ""), qty: String(o.qty - o.filledQty) });
    setEditError(null);
  }

  async function submitEdit() {
    if (!editing) return;
    setEditBusy(true);
    setEditError(null);
    try {
      const result = await api<{ amended: boolean; reason: string | null }>(`/orders/${editing.id}`, {
        method: "PATCH",
        body: { price: Number(editing.price), qty: Number(editing.qty) },
      });
      if (!result.amended) setEditError(result.reason ?? "정정하지 못했습니다");
      else setEditing(null);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "정정 실패");
    } finally {
      setEditBusy(false);
      refresh();
    }
  }

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
          if (editing?.id === o.id) {
            const tick = tickSizeOf(o.symbol);
            const price = Number(editing.price);
            const qty = Number(editing.qty);
            const remaining = o.qty - o.filledQty;
            const priceOk = Number.isSafeInteger(price) && price > 0 && (tick == null || isOnTick(price, tick));
            const qtyOk = Number.isSafeInteger(qty) && qty > 0 && qty <= remaining;
            const unchanged = price === o.price && qty === remaining;
            return (
              <li
                key={o.id}
                className="space-y-1.5 border-b border-hairline-soft bg-sky/4 px-4 py-2 last:border-b-0"
              >
                <div className="flex items-center gap-2">
                  <span className={`w-8 shrink-0 font-semibold ${o.side === "BUY" ? "text-up" : "text-down"}`}>
                    {o.side === "BUY" ? "매수" : "매도"}
                  </span>
                  <span className="shrink-0 font-medium">{o.symbol}</span>
                  <span className="text-ink-faint">정정</span>
                  <input
                    className="field ml-auto w-24 py-1 text-xs"
                    inputMode="numeric"
                    aria-label="정정 가격"
                    value={editing.price}
                    onChange={(e) => setEditing({ ...editing, price: e.target.value.replace(/[^0-9]/g, "") })}
                  />
                  <input
                    className="field w-16 py-1 text-xs"
                    inputMode="numeric"
                    aria-label="정정 수량"
                    value={editing.qty}
                    onChange={(e) => setEditing({ ...editing, qty: e.target.value.replace(/[^0-9]/g, "") })}
                  />
                  <button
                    onClick={submitEdit}
                    disabled={editBusy || !priceOk || !qtyOk || unchanged}
                    className="btn btn-primary btn-sm shrink-0"
                  >
                    {editBusy ? "정정 중…" : "확인"}
                  </button>
                  <button onClick={() => setEditing(null)} className="btn btn-ghost btn-sm shrink-0">
                    닫기
                  </button>
                </div>
                <p className="text-[11px] text-ink-faint">
                  취소 후 남은 수량으로 다시 접수합니다 · 남은 {fmt.format(remaining)}주 이하
                  {tick != null && ` · 호가 단위 ${fmt.format(tick)}원`}
                  {editError && <span className="ml-2 text-warn">{editError}</span>}
                </p>
              </li>
            );
          }
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
              {o.type === "LIMIT" && (
                <button
                  onClick={() => startEdit(o)}
                  className="btn btn-ghost btn-sm relative shrink-0"
                  title="가격·남은 수량을 고쳐 다시 접수합니다"
                >
                  정정
                </button>
              )}
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
