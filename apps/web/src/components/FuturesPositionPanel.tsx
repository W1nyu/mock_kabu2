"use client";

import { futureDef } from "@mock-kabu/shared";
import { useCallback, useEffect, useState } from "react";
import { api, getUser } from "@/lib/api";
import { fmtFuture, krw, type FuturesAccount } from "@/lib/futures";
import { subscribe } from "@/lib/socket";
import { everyVisible } from "@/lib/visible-interval";

interface LiveOrder {
  id: string;
  side: "BUY" | "SELL";
  type: string;
  price: number | null;
  qty: number;
  filledQty: number;
}

function tone(n: number): string {
  return n > 0 ? "text-up" : n < 0 ? "text-down" : "text-ink-muted";
}

/**
 * 내 선물 포지션·증거금과 이 종목의 미체결 주문. 체결·주문 변화는 계좌 채널 알림으로 바로 다시 읽고,
 * 평가손익은 선물 가격이 움직이므로 10초마다(탭이 보일 때만) 갱신한다.
 */
export default function FuturesPositionPanel({ symbol, refreshKey }: { symbol: string; refreshKey: number }) {
  const [account, setAccount] = useState<FuturesAccount | null>(null);
  const [orders, setOrders] = useState<LiveOrder[]>([]);
  const [loggedIn, setLoggedIn] = useState(false);
  useEffect(() => setLoggedIn(getUser() != null), []);

  const load = useCallback(() => {
    if (!getUser()) return;
    api<FuturesAccount>("/account/futures").then(setAccount).catch(() => {});
    api<LiveOrder[]>(`/orders?symbol=${symbol}&status=live&limit=50`).then(setOrders).catch(() => {});
  }, [symbol]);

  useEffect(() => {
    load();
    const stop = everyVisible(load, 10_000);
    const u = getUser();
    const unsub = u ? subscribe([`account:${u.accountId}`], () => load()) : () => {};
    return () => {
      stop();
      unsub();
    };
  }, [load, refreshKey]);

  if (!loggedIn) return null;
  const position = account?.positions.find((p) => p.symbol === symbol) ?? null;
  const def = futureDef(symbol)!;
  const ratio = account && account.maintenanceMargin > 0 ? (account.equity / account.maintenanceMargin) * 100 : null;

  return (
    <section className="glass overflow-hidden">
      <div className="panel-head">
        <span className="panel-title">내 선물</span>
        {ratio != null && (
          <span className={`num text-[11px] font-medium ${ratio < 100 ? "text-down" : ratio < 150 ? "text-warn" : "text-ink-muted"}`}>
            유지증거금 대비 {ratio.toFixed(0)}%
          </span>
        )}
      </div>
      <div className="space-y-3 p-4 text-[13px]">
        {position ? (
          <dl className="num grid grid-cols-2 gap-x-4 gap-y-1.5">
            <dt className="text-ink-muted">포지션</dt>
            <dd className={`text-right font-semibold ${position.qty > 0 ? "text-up" : "text-down"}`}>
              {position.qty > 0 ? "롱" : "숏"} {Math.abs(position.qty)}계약
            </dd>
            <dt className="text-ink-muted">평균가</dt>
            <dd className="text-right">{fmtFuture(symbol, Math.round(position.avgPrice))}</dd>
            <dt className="text-ink-muted">평가손익</dt>
            <dd className={`text-right font-semibold ${tone(position.unrealized)}`}>
              {position.unrealized > 0 ? "+" : ""}
              {krw(position.unrealized)}
            </dd>
            <dt className="text-ink-muted">증거금</dt>
            <dd className="text-right">{krw(position.marginHeld)}</dd>
          </dl>
        ) : (
          <p className="text-ink-faint">{def.name} 포지션이 없습니다.</p>
        )}

        {account && (account.positions.length > 0 || account.debt > 0) && (
          <dl className="num grid grid-cols-2 gap-x-4 gap-y-1.5 border-t border-hairline-soft pt-3">
            <dt className="text-ink-muted">선물 평가손익 합계</dt>
            <dd className={`text-right ${tone(account.unrealized)}`}>{krw(account.unrealized)}</dd>
            <dt className="text-ink-muted">묶인 증거금</dt>
            <dd className="text-right">{krw(account.marginHeld)}</dd>
            <dt className="text-ink-muted">유지증거금</dt>
            <dd className="text-right">{krw(account.maintenanceMargin)}</dd>
            {account.debt > 0 && (
              <>
                <dt className="text-down">미수금</dt>
                <dd className="text-right text-down">{krw(account.debt)}</dd>
              </>
            )}
          </dl>
        )}

        {orders.length > 0 && (
          <div className="border-t border-hairline-soft pt-3">
            <p className="mb-2 text-xs text-ink-muted">미체결 주문</p>
            <ul className="space-y-1.5">
              {orders.map((order) => (
                <li key={order.id} className="num flex items-center justify-between gap-2">
                  <span className={order.side === "BUY" ? "text-up" : "text-down"}>
                    {order.side === "BUY" ? "매수" : "매도"} {order.qty - order.filledQty}계약 @{" "}
                    {order.price == null ? "시장가" : fmtFuture(symbol, order.price)}
                  </span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => api(`/orders/${order.id}`, { method: "DELETE" }).then(load).catch(() => {})}
                  >
                    취소
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
