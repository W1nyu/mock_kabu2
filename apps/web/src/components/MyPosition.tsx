"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, fmt, getUser, won } from "@/lib/api";
import { subscribe } from "@/lib/socket";

interface HoldingRow {
  symbol: string;
  qty: number;
  holdQty: number;
  availableQty: number;
  lastPrice: number;
  costBasis: number;
  avgCost: number;
}

interface RealizedSummary {
  bySymbol: { symbol: string; realized: number; qty: number; realizedRate: number | null }[];
}

/** 해당 종목 보유 포지션 요약 — 평단가·실시간 수익률·청산. 포지션이 없으면 렌더하지 않음 */
export default function MyPosition({ symbol }: { symbol: string }) {
  const [holding, setHolding] = useState<HoldingRow | null>(null);
  const [realized, setRealized] = useState<number | null>(null);
  const [livePrice, setLivePrice] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(() => {
    api<HoldingRow[]>("/account/holdings")
      .then((rows) => setHolding(rows.find((h) => h.symbol === symbol && h.qty > 0) ?? null))
      .catch(() => {});
    api<RealizedSummary>("/account/realized?limit=1")
      .then((summary) => {
        const row = summary.bySymbol.find((entry) => entry.symbol === symbol);
        setRealized(row && row.qty > 0 ? row.realized : null);
      })
      .catch(() => {});
  }, [symbol]);

  useEffect(() => {
    setHolding(null);
    setRealized(null);
    setLivePrice(null);
    setConfirming(false);
    setMessage(null);
    refresh();
    const t = setInterval(refresh, 5000);
    const user = getUser();
    const unsubAccount = user ? subscribe([`account:${user.accountId}`], () => refresh()) : () => {};
    const unsubTrades = subscribe([`trades:${symbol}`], ({ data }) => {
      if (Number.isFinite(data?.price)) setLivePrice(data.price);
    });
    return () => {
      clearInterval(t);
      unsubAccount();
      unsubTrades();
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    };
  }, [symbol, refresh]);

  async function liquidate() {
    if (!holding || holding.availableQty <= 0) return;
    setBusy(true);
    setMessage(null);
    try {
      await api("/orders", {
        method: "POST",
        body: { symbol, side: "SELL", type: "MARKET", qty: holding.availableQty },
      });
      setMessage(`청산 주문 접수: ${fmt.format(holding.availableQty)}주 시장가 매도`);
      refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "청산 실패");
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  function onLiquidateClick() {
    if (confirming) {
      void liquidate();
      return;
    }
    // 오클릭 방지: 첫 클릭은 확인 상태로만 전환, 4초 내 재클릭 시 실행
    setConfirming(true);
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    confirmTimer.current = setTimeout(() => setConfirming(false), 4000);
  }

  if (!holding) return null;

  const price = livePrice ?? holding.lastPrice;
  const value = price * holding.qty;
  const pnl = value - holding.costBasis;
  const pnlRate = holding.costBasis > 0 ? pnl / holding.costBasis : 0;
  const pnlColor = pnl >= 0 ? "text-up" : "text-down";
  const sign = pnl >= 0 ? "+" : "";

  return (
    <div className="glass flex flex-wrap items-center gap-x-7 gap-y-3 px-5 py-3.5 text-sm">
      <span className="panel-title">내 포지션</span>
      <Item label="보유">
        {fmt.format(holding.qty)}주
        {holding.holdQty > 0 && (
          <span className="text-ink-faint"> (매도 대기 {fmt.format(holding.holdQty)})</span>
        )}
      </Item>
      <Item label="평단가">{fmt.format(Math.round(holding.avgCost))}</Item>
      <Item label="현재가">{fmt.format(price)}</Item>
      <Item label="평가손익">
        <span className={`font-semibold ${pnlColor}`}>
          {sign}
          {won(pnl)} ({sign}
          {(pnlRate * 100).toFixed(2)}%)
        </span>
      </Item>
      {realized != null && (
        <Item label="실현손익">
          <span
            className={`font-semibold ${realized > 0 ? "text-up" : realized < 0 ? "text-down" : ""}`}
            title="이 종목의 매도 체결에서 지금까지 확정된 손익 합계"
          >
            {realized > 0 ? "+" : ""}
            {won(realized)}
          </span>
        </Item>
      )}
      <div className="ml-auto flex items-center gap-3">
        {message && <span className="text-xs text-ink-muted">{message}</span>}
        <button
          onClick={onLiquidateClick}
          disabled={busy || holding.availableQty <= 0}
          title={
            holding.availableQty <= 0
              ? "매도 대기 중인 수량뿐이라 청산할 수 없습니다"
              : "보유 수량 전체를 시장가로 매도합니다"
          }
          className={`btn btn-sm ${
            confirming
              ? "btn-sell"
              : "border-down/50 bg-down/10 text-down hover:bg-down/16"
          }`}
        >
          {confirming ? `${fmt.format(holding.availableQty)}주 전량 매도 확인` : "포지션 청산"}
        </button>
      </div>
    </div>
  );
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="num">
      <span className="mr-1.5 text-xs text-ink-faint">{label}</span>
      {children}
    </span>
  );
}
