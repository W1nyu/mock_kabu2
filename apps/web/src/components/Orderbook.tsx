"use client";

import { useEffect, useState } from "react";
import { api, fmt } from "@/lib/api";
import { subscribe } from "@/lib/socket";

interface Level {
  price: number;
  qty: number;
}
interface Snapshot {
  symbol: string;
  bids: Level[];
  asks: Level[];
  lastPrice: number | null;
  seq: number;
}

export default function Orderbook({
  symbol,
  onPriceClick,
}: {
  symbol: string;
  onPriceClick?: (price: number) => void;
}) {
  const [snap, setSnap] = useState<Snapshot | null>(null);

  useEffect(() => {
    api<Snapshot>(`/market/orderbook/${symbol}`, { auth: false }).then(setSnap).catch(() => {});
    let lastSeq = 0;
    return subscribe([`orderbook:${symbol}`], ({ channel, data }) => {
      if (channel !== `orderbook:${symbol}`) return;
      if (data.seq > lastSeq) {
        lastSeq = data.seq;
        setSnap(data);
      }
    });
  }, [symbol]);

  const maxQty = Math.max(
    1,
    ...(snap?.asks ?? []).map((l) => l.qty),
    ...(snap?.bids ?? []).map((l) => l.qty),
  );

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900">
      <div className="border-b border-neutral-800 px-3 py-2 text-xs font-semibold text-neutral-400">
        호가창
      </div>
      <div className="text-xs tabular-nums">
        {/* 매도(asks): 낮은 가격이 아래로 */}
        <div className="flex flex-col-reverse">
          {(snap?.asks ?? []).slice(0, 8).map((l) => (
            <Row key={`a${l.price}`} level={l} side="ask" maxQty={maxQty} onClick={onPriceClick} />
          ))}
        </div>
        <div className="border-y border-neutral-800 px-3 py-1.5 text-center text-sm font-bold text-neutral-100">
          {snap?.lastPrice != null ? fmt.format(snap.lastPrice) : "—"}
        </div>
        <div>
          {(snap?.bids ?? []).slice(0, 8).map((l) => (
            <Row key={`b${l.price}`} level={l} side="bid" maxQty={maxQty} onClick={onPriceClick} />
          ))}
        </div>
      </div>
    </div>
  );
}

function Row({
  level,
  side,
  maxQty,
  onClick,
}: {
  level: Level;
  side: "ask" | "bid";
  maxQty: number;
  onClick?: (price: number) => void;
}) {
  const width = Math.max(2, (level.qty / maxQty) * 100);
  return (
    <button
      className="relative flex w-full justify-between px-3 py-0.5 hover:bg-neutral-800"
      onClick={() => onClick?.(level.price)}
      title="클릭하면 주문 가격에 입력됩니다"
    >
      <span
        className={`absolute inset-y-0 right-0 ${side === "ask" ? "bg-blue-500/15" : "bg-red-500/15"}`}
        style={{ width: `${width}%` }}
      />
      <span className={`relative ${side === "ask" ? "text-blue-400" : "text-red-400"}`}>
        {fmt.format(level.price)}
      </span>
      <span className="relative text-neutral-300">{fmt.format(level.qty)}</span>
    </button>
  );
}
