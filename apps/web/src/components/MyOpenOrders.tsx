"use client";

import { isOnTick, tickSizeOf } from "@mock-kabu/shared";
import { useCallback, useEffect, useState } from "react";
import { api, fmt, getUser, won } from "@/lib/api";
import { ACCOUNT_REFRESH_DEBOUNCE_MS, debounce } from "@/lib/debounce";
import { subscribe } from "@/lib/socket";
import { everyVisible } from "@/lib/visible-interval";
import { serverText, useT } from "@/lib/i18n";

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
  priceHint,
}: {
  symbol?: string;
  /** Bumps immediately after this page successfully accepts an order. */
  refreshKey?: number;
  /** 호가창 클릭 — 정정 중인 주문이 있으면 그 가격 칸에 넣는다. */
  priceHint?: { price: number; seq: number } | null;
}) {
  const tr = useT();
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
    const refreshSoon = debounce(refresh, ACCOUNT_REFRESH_DEBOUNCE_MS);
    const unsub = user ? subscribe([`account:${user.accountId}`], () => refreshSoon()) : () => {};
    // Account pushes and the order form's direct refresh are the normal path.
    // Keep a light fallback for a reconnect that missed both.
    const t = everyVisible(refresh, 15_000);
    return () => {
      unsub();
      refreshSoon.cancel();
      t();
    };
  }, [refresh]);

  useEffect(() => {
    if (priceHint == null) return;
    setEditing((current) => (current ? { ...current, price: String(priceHint.price) } : current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [priceHint?.seq]);

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
      if (!result.amended) setEditError(result.reason ? serverText(result.reason) : tr("정정하지 못했습니다"));
      else setEditing(null);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : tr("정정 실패"));
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
        <span className="panel-title">{tr("내 미체결 주문")}</span>
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
                    {o.side === "BUY" ? tr("매수") : tr("매도")}
                  </span>
                  <span className="shrink-0 font-medium">{o.symbol}</span>
                  <span className="text-ink-faint">{tr("정정")}</span>
                  <input
                    className="field ml-auto w-24 py-1 text-xs"
                    inputMode="numeric"
                    aria-label={tr("정정 가격")}
                    value={editing.price}
                    onChange={(e) => setEditing({ ...editing, price: e.target.value.replace(/[^0-9]/g, "") })}
                  />
                  <input
                    className="field w-16 py-1 text-xs"
                    inputMode="numeric"
                    aria-label={tr("정정 수량")}
                    value={editing.qty}
                    onChange={(e) => setEditing({ ...editing, qty: e.target.value.replace(/[^0-9]/g, "") })}
                  />
                  <button
                    onClick={submitEdit}
                    disabled={editBusy || !priceOk || !qtyOk || unchanged}
                    className="btn btn-primary btn-sm shrink-0"
                  >
                    {editBusy ? tr("정정 중…") : tr("확인")}
                  </button>
                  <button onClick={() => setEditing(null)} className="btn btn-ghost btn-sm shrink-0">
                    {tr("닫기")}
                  </button>
                </div>
                <p className="text-[11px] text-ink-faint">
                  {tr("호가창을 누르면 가격이 들어갑니다 · 취소 후 남은 수량으로 다시 접수 · 남은 {n}주 이하", { n: fmt.format(remaining) })}
                  {tick != null && ` · ${tr("호가 단위 {tick}", { tick: won(tick) })}`}
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
                className="absolute inset-y-0 left-0 bg-surface-3/25"
                style={{ width: `${pct}%` }}
                aria-hidden
              />
              <span
                className={`relative w-8 shrink-0 font-semibold ${o.side === "BUY" ? "text-up" : "text-down"}`}
              >
                {o.side === "BUY" ? tr("매수") : tr("매도")}
              </span>
              <span className="relative shrink-0 font-medium">{o.symbol}</span>
              <span className="relative ml-auto text-ink-muted">
                {o.price != null ? fmt.format(o.price) : tr("시장가")}
              </span>
              <span className="relative w-16 shrink-0 text-right text-ink-faint">
                {fmt.format(o.filledQty)}/{fmt.format(o.qty)}
              </span>
              {o.type === "LIMIT" && (
                <button
                  onClick={() => startEdit(o)}
                  className="btn btn-ghost btn-sm relative shrink-0"
                  title={tr("가격·남은 수량을 고쳐 다시 접수합니다")}
                >
                  {tr("정정")}
                </button>
              )}
              <button
                onClick={() => cancel(o.id)}
                className="btn btn-ghost btn-sm relative shrink-0"
              >
                {tr("취소|동작")}
              </button>
            </li>
          );
        })}
        {orders.length === 0 && (
          <li className="px-4 py-8 text-center text-ink-faint">{tr("미체결 주문 없음")}</li>
        )}
      </ul>
    </div>
  );
}
