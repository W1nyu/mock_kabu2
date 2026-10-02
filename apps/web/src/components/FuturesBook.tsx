"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { fmtFuture } from "@/lib/futures";
import { bookBarWidth } from "@/lib/orderbook-scale";
import { subscribe } from "@/lib/socket";
import { useOrderbookScale } from "@/lib/use-orderbook-scale";
import { useT } from "@/lib/i18n";

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

/**
 * 선물·옵션 호가(한쪽 5단). 가격을 누르면 주문창 가격에 채운다.
 * 현물 호가창처럼 호가 수가 변해도 항상 5행씩 그려 높이가 고정이다 — 폰 주문 시트에서 아래 주문창이 들썩이지 않게.
 * 막대 기준(최대 잔량)도 현물과 같이 0.8초 지속된 변화만 반영한다.
 */
export default function FuturesBook({ symbol, onPick }: { symbol: string; onPick: (price: number) => void }) {
  const t = useT();
  const [snap, setSnap] = useState<Snapshot | null>(null);

  useEffect(() => {
    let active = true;
    setSnap(null);
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

  const asks = (snap?.asks ?? []).slice(0, DEPTH);
  const bids = (snap?.bids ?? []).slice(0, DEPTH);
  const observedMax = snap ? Math.max(1, ...asks.map((l) => l.qty), ...bids.map((l) => l.qty)) : null;
  const maxQty = useOrderbookScale(symbol, observedMax);
  const pad = (levels: Level[]): (Level | null)[] => [...levels, ...Array<null>(DEPTH - levels.length).fill(null)];

  const row = (level: Level | null, side: "ask" | "bid", index: number) =>
    level ? (
      <li key={`${side}-${level.price}`}>
        <button
          type="button"
          onClick={() => onPick(level.price)}
          className="relative flex w-full items-center justify-between px-4 py-1.5 text-[13px] transition-colors hover:bg-surface-3/30"
        >
          <span
            aria-hidden
            className={`absolute inset-y-0.5 right-0 transition-[width] duration-300 motion-reduce:transition-none ${side === "ask" ? "bg-down/10" : "bg-up/10"}`}
            style={{ width: `${bookBarWidth(level.qty, maxQty)}%` }}
          />
          <span className={`num relative font-medium ${side === "ask" ? "text-down" : "text-up"}`}>{fmtFuture(symbol, level.price)}</span>
          <span className="num relative text-ink-muted">{level.qty.toLocaleString("ko-KR")}</span>
        </button>
      </li>
    ) : (
      <li key={`${side}-empty-${index}`} aria-hidden className="px-4 py-1.5 text-[13px] text-transparent">
        &nbsp;
      </li>
    );

  return (
    <section className="glass overflow-hidden">
      <div className="panel-head">
        <span className="panel-title">{t("호가")}</span>
        <span className="num text-[11px] text-ink-faint">
          {snap ? `${t("현재가")} ${fmtFuture(symbol, snap.lastPrice)}` : t("불러오는 중…")}
        </span>
      </div>
      {/* 매도는 낮은 가격이 아래(가운데 쪽)로, 빈 행은 위쪽 끝에 */}
      <ul>{pad(asks).map((l, i) => row(l, "ask", i)).reverse()}</ul>
      <div className="border-y border-hairline-soft" />
      <ul>{pad(bids).map((l, i) => row(l, "bid", i))}</ul>
    </section>
  );
}
