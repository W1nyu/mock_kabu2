"use client";

import { FUTURES_EMERGENCY_LOSS_BPS, futureDef } from "@mock-kabu/shared";
import { useCallback, useEffect, useState } from "react";
import { api, getUser } from "@/lib/api";
import FuturesPositionActions from "./FuturesPositionActions";
import { fmtFuture, krw, leverageLabel, type FuturesAccount } from "@/lib/futures";
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

function remaining(deadline: string, now: number): string {
  const ms = Math.max(0, Date.parse(deadline) - now);
  const m = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/**
 * 긴급 반대매매가 걸리는 선물 가격(정수 단위) 추정: 평가손실 = 포지션 위탁증거금 × 90%가 되는 가격.
 * 계좌 전체의 추가증거금(30분 유예)은 현금에 따라 더 일찍 걸릴 수 있다.
 */
function emergencyPrice(qty: number, avgPrice: number, marginHeld: number, unitValue: number): number {
  const lossUnits = (marginHeld * FUTURES_EMERGENCY_LOSS_BPS) / 10_000 / (Math.abs(qty) * unitValue);
  return qty > 0 ? avgPrice - lossUnits : avgPrice + lossUnits;
}

/** 평가예탁금 ÷ 유지증거금 게이지. 100% 아래는 추가증거금, 위탁증거금(= 유지 × 1.5) 위는 여유. */
function MarginGauge({ equity, maintenance, initial }: { equity: number; maintenance: number; initial: number }) {
  const ratio = maintenance > 0 ? equity / maintenance : 0;
  const initialRatio = maintenance > 0 ? initial / maintenance : 1.5;
  const max = Math.max(3, initialRatio * 1.6);
  const pct = (value: number) => `${Math.max(0, Math.min(100, (value / max) * 100))}%`;
  const color = ratio < 1 ? "bg-down" : ratio < initialRatio ? "bg-warn" : "bg-ok";
  return (
    <div className="space-y-1">
      <div className="relative h-2 overflow-hidden rounded-full bg-surface-2">
        <div className={`h-full rounded-full ${color}`} style={{ width: pct(ratio) }} />
        <span className="absolute inset-y-0 w-px bg-down" style={{ left: pct(1) }} aria-hidden />
        <span className="absolute inset-y-0 w-px bg-ink-faint" style={{ left: pct(initialRatio) }} aria-hidden />
      </div>
      <div className="relative h-3 text-[10px] text-ink-faint">
        <span className="absolute -translate-x-1/2" style={{ left: pct(1) }}>
          유지
        </span>
        <span className="absolute -translate-x-1/2" style={{ left: pct(initialRatio) }}>
          위탁
        </span>
      </div>
    </div>
  );
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
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => setLoggedIn(getUser() != null), []);
  // 추가증거금 기한 카운트다운 — 걸려 있을 때만 1초마다 다시 그린다.
  const hasCall = account?.marginCall != null;
  useEffect(() => {
    if (!hasCall) return;
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [hasCall]);

  const load = useCallback(() => {
    if (!getUser()) return;
    api<FuturesAccount>("/account/futures")
      .then(setAccount)
      .catch(() => {});
    api<LiveOrder[]>(`/orders?symbol=${symbol}&status=live&limit=50`)
      .then(setOrders)
      .catch(() => {});
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
          <span
            className={`num text-[11px] font-medium ${ratio < 100 ? "text-down" : ratio < 150 ? "text-warn" : "text-ink-muted"}`}
          >
            유지증거금 대비 {ratio.toFixed(0)}%
          </span>
        )}
      </div>
      <div className="space-y-3 p-4 text-[13px]">
        {account?.marginCall && (
          <div role="alert" className="rounded-xl border border-warn/40 bg-warn/10 p-3">
            <p className="flex items-center justify-between gap-2 font-semibold text-warn">
              <span>추가증거금 발생</span>
              <span className="num">{remaining(account.marginCall.deadline, now)} 남음</span>
            </p>
            <p className="num mt-1 text-ink">
              {account.marginCall.shortfall > 0 ? `${krw(account.marginCall.shortfall)} 더 필요` : "곧 해소됩니다"}
              <span className="text-ink-faint"> (발생 시 {krw(account.marginCall.required)})</span>
            </p>
            <p className="mt-1 text-[11px] leading-5 text-ink-muted">
              기한까지 입금하거나 포지션을 줄여 위탁증거금 수준을 회복하지 않으면 모자란 비율만큼 시장가로 반대매매됩니다.
              평가손실이 증거금의 90%에 닿으면 기한과 상관없이 즉시 전량 반대매매됩니다.
            </p>
          </div>
        )}
        {position ? (
          <dl className="num grid grid-cols-2 gap-x-4 gap-y-1.5">
            <dt className="text-ink-muted">포지션</dt>
            <dd className={`text-right font-semibold ${position.qty > 0 ? "text-up" : "text-down"}`}>
              {position.qty > 0 ? "롱" : "숏"} {Math.abs(position.qty)}계약
            </dd>
            <dt className="text-ink-muted">레버리지</dt>
            <dd className="text-right">{leverageLabel(symbol, position.leverage)}</dd>
            <dt className="text-ink-muted">평균가</dt>
            <dd className="text-right">{fmtFuture(symbol, Math.round(position.avgPrice))}</dd>
            <dt className="text-ink-muted">평가손익</dt>
            <dd className={`text-right font-semibold ${tone(position.unrealized)}`}>
              {position.unrealized > 0 ? "+" : ""}
              {krw(position.unrealized)}
            </dd>
            <dt className="text-ink-muted">증거금</dt>
            <dd className="text-right">{krw(position.marginHeld)}</dd>
            <dt className="text-ink-muted">긴급 반대매매가</dt>
            <dd className="text-right text-ink-muted">
              {fmtFuture(symbol, Math.round(emergencyPrice(position.qty, position.avgPrice, position.marginHeld, def.unitValue)))}
            </dd>
          </dl>
        ) : (
          <p className="text-ink-faint">{def.name} 포지션이 없습니다.</p>
        )}
        {position && (
          <FuturesPositionActions
            symbol={symbol}
            qty={position.qty}
            markPrice={position.markPrice}
            avgPrice={position.avgPrice}
            refreshKey={refreshKey}
            onChanged={load}
          />
        )}

        {account && (account.positions.length > 0 || account.debt > 0) && (
          <div className="space-y-2 border-t border-hairline-soft pt-3">
            {account.maintenanceMargin > 0 && (
              <MarginGauge equity={account.equity} maintenance={account.maintenanceMargin} initial={account.initialMargin} />
            )}
            <dl className="num grid grid-cols-2 gap-x-4 gap-y-1.5">
              <dt className="text-ink-muted">선물 평가손익 합계</dt>
              <dd className={`text-right ${tone(account.unrealized)}`}>{krw(account.unrealized)}</dd>
              <dt className="text-ink-muted">묶인 증거금</dt>
              <dd className="text-right">{krw(account.marginHeld)}</dd>
              <dt className="text-ink-muted">평가예탁금</dt>
              <dd className="text-right">{krw(account.equity)}</dd>
              <dt className="text-ink-muted">유지증거금</dt>
              <dd className="text-right">{krw(account.maintenanceMargin)}</dd>
              {account.debt > 0 && (
                <>
                  <dt className="text-down">미수금</dt>
                  <dd className="text-right text-down">{krw(account.debt)}</dd>
                </>
              )}
            </dl>
          </div>
        )}

        {account && account.liquidations.length > 0 && (
          <div className="border-t border-hairline-soft pt-3">
            <p className="mb-2 text-xs text-ink-muted">반대매매 내역</p>
            <ul className="space-y-1">
              {account.liquidations.slice(0, 5).map((row) => (
                <li key={row.orderId} className="num flex items-center justify-between gap-2 text-[12px]">
                  <span>
                    <span className="mr-1.5 rounded bg-down/12 px-1.5 py-0.5 text-[10px] font-semibold text-down">
                      {row.reason === "EMERGENCY" ? "긴급" : "기한 초과"}
                    </span>
                    {row.symbol} {row.side === "BUY" ? "매수" : "매도"} {row.qty}계약
                  </span>
                  <span className="text-ink-faint">
                    {new Date(row.createdAt).toLocaleString("ko-KR", {
                      month: "numeric",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                      timeZone: "Asia/Seoul",
                    })}
                  </span>
                </li>
              ))}
            </ul>
          </div>
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
                    onClick={() =>
                      api(`/orders/${order.id}`, { method: "DELETE" })
                        .then(load)
                        .catch(() => {})
                    }
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
