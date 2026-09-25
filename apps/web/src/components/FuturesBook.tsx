"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { fmtFuture } from "@/lib/futures";
import { subscribe } from "@/lib/socket";

interface Level {
  price: number;
  qty: number;
}
interface Snapshot {
  bids: Level[];
  asks: Level[];
  lastPrice: number | null;
}

const DEPTH = 5;

/** 선물 호가(한쪽 5단). 가격을 누르면 주문창 가격에 채운다. */
export default function FuturesBook({ symbol, onPick }: { symbol: string; onPick: (price: number) => void }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);

  useEffect(() => {
    let active = true;
    api<Snapshot>(`/market/orderbook/${symbol}`, { auth: false })
      .then((data) => {
        if (active) setSnap(data);
      })
      .catch(() => {});
    const unsubscribe = subscribe([`orderbook:${symbol}`], ({ data }) => {
      const next = data as Snapshot;
      if (active && Array.isArray(next?.bids) && Array.isArray(next?.asks)) setSnap(next);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [symbol]);

  const asks = (snap?.asks ?? []).slice(0, DEPTH).reverse();
  const bids = (snap?.bids ?? []).slice(0, DEPTH);
  const maxQty = Math.max(1, ...asks.map((l) => l.qty), ...bids.map((l) => l.qty));

  const row = (level: Level, side: "ask" | "bid") => (
    <li key={`${side}-${level.price}`}>
      <button
        type="button"
        onClick={() => onPick(level.price)}
        className="relative flex w-full items-center justify-between px-4 py-1.5 text-[13px] transition-colors hover:bg-surface-3/30"
      >
        <span
          aria-hidden
          className={`absolute inset-y-0.5 right-0 ${side === "ask" ? "bg-down/10" : "bg-up/10"}`}
          style={{ width: `${(level.qty / maxQty) * 100}%` }}
        />
        <span className={`num relative font-medium ${side === "ask" ? "text-down" : "text-up"}`}>{fmtFuture(symbol, level.price)}</span>
        <span className="num relative text-ink-muted">{level.qty}계약</span>
      </button>
    </li>
  );

  return (
    <section className="glass overflow-hidden">
      <div className="panel-head">
        <span className="panel-title">호가</span>
        <span className="num text-[11px] text-ink-faint">현재가 {fmtFuture(symbol, snap?.lastPrice)}</span>
      </div>
      <ul>{asks.map((l) => row(l, "ask"))}</ul>
      <div className="border-y border-hairline-soft" />
      <ul>{bids.map((l) => row(l, "bid"))}</ul>
      {!snap && <p className="py-6 text-center text-sm text-ink-faint">불러오는 중…</p>}
    </section>
  );
}
