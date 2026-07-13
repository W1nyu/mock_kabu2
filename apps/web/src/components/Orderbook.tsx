"use client";

import { useEffect, useRef, useState } from "react";
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

interface SessionExecutionStats {
  buyVolume: number;
  sellVolume: number;
}

interface SummaryDto {
  buyVolume: number | string | null;
  sellVolume: number | string | null;
  lastTradeTs: number | string | null;
}

interface TradeTick {
  id: string;
  qty: number;
  takerSide: "BUY" | "SELL";
  ts: number;
}

type DepthChange = "increase" | "decrease";

function finiteNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function statsFromSummary(summary: SummaryDto): SessionExecutionStats {
  return {
    buyVolume: Math.max(0, finiteNumber(summary.buyVolume) ?? 0),
    sellVolume: Math.max(0, finiteNumber(summary.sellVolume) ?? 0),
  };
}

function withTick(previous: SessionExecutionStats | null, tick: TradeTick): SessionExecutionStats {
  return {
    buyVolume: (previous?.buyVolume ?? 0) + (tick.takerSide === "BUY" ? tick.qty : 0),
    sellVolume: (previous?.sellVolume ?? 0) + (tick.takerSide === "SELL" ? tick.qty : 0),
  };
}

function parseTick(data: any): TradeTick | null {
  const ts = finiteNumber(data?.ts);
  const qty = finiteNumber(data?.qty);
  const takerSide = data?.takerSide === "BUY" || data?.takerSide === "SELL" ? data.takerSide : null;
  if (ts == null || qty == null || qty < 0 || takerSide == null) return null;
  const id = typeof data?.tradeId === "string" ? data.tradeId : `${ts}:${takerSide}:${qty}`;
  return { id, qty, takerSide, ts };
}

export default function Orderbook({
  symbol,
  onPriceClick,
}: {
  symbol: string;
  onPriceClick?: (price: number) => void;
}) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [executionStats, setExecutionStats] = useState<SessionExecutionStats | null>(null);
  const [depthChanges, setDepthChanges] = useState<Record<string, DepthChange>>({});
  const previousRef = useRef<Snapshot | null>(null);
  const flashTimerRef = useRef<number | null>(null);
  const pendingTicksRef = useRef(new Map<string, TradeTick>());
  const summaryWatermarkRef = useRef<number | null>(null);

  useEffect(() => {
    let disposed = false;
    previousRef.current = null;
    pendingTicksRef.current.clear();
    summaryWatermarkRef.current = null;
    setExecutionStats(null);
    setDepthChanges({});
    api<Snapshot>(`/market/orderbook/${symbol}`, { auth: false })
      .then((initial) => {
        previousRef.current = initial;
        setSnap(initial);
      })
      .catch(() => {});

    const loadSummary = () => {
      api<SummaryDto>(`/market/summary/${symbol}`, { auth: false })
        .then((summary) => {
          if (disposed) return;

          const watermark = finiteNumber(summary.lastTradeTs) ?? Number.NEGATIVE_INFINITY;
          const pendingAfterSnapshot: TradeTick[] = [];
          for (const [id, tick] of pendingTicksRef.current) {
            if (tick.ts > watermark) pendingAfterSnapshot.push(tick);
            else pendingTicksRef.current.delete(id);
          }

          summaryWatermarkRef.current = watermark;
          setExecutionStats(() => pendingAfterSnapshot.reduce(withTick, statsFromSummary(summary)));
        })
        .catch(() => {
          // 서버 스냅샷이 잠시 실패해도 이후 WebSocket 체결로 체결강도를 계속 갱신한다.
        });
    };

    loadSummary();
    const refreshTimer = window.setInterval(loadSummary, 30_000);
    let lastSeq = 0;
    const unsubscribe = subscribe([`orderbook:${symbol}`, `trades:${symbol}`], ({ channel, data }) => {
      if (channel === `trades:${symbol}`) {
        const tick = parseTick(data);
        if (tick) {
          pendingTicksRef.current.set(tick.id, tick);
          const watermark = summaryWatermarkRef.current;
          if (watermark == null || tick.ts > watermark) {
            setExecutionStats((previous) => withTick(previous, tick));
          }
        }
        return;
      }
      if (channel === `orderbook:${symbol}` && data.seq > lastSeq) {
        const previous = previousRef.current;
        const changes = findDepthChanges(previous, data);
        lastSeq = data.seq;
        previousRef.current = data;
        setSnap(data);
        if (Object.keys(changes).length > 0) {
          setDepthChanges(changes);
          if (flashTimerRef.current != null) window.clearTimeout(flashTimerRef.current);
          flashTimerRef.current = window.setTimeout(() => setDepthChanges({}), 900);
        }
      }
    });
    return () => {
      disposed = true;
      window.clearInterval(refreshTimer);
      unsubscribe();
      if (flashTimerRef.current != null) window.clearTimeout(flashTimerRef.current);
    };
  }, [symbol]);

  const executionStrength =
    executionStats && executionStats.sellVolume > 0 ? (executionStats.buyVolume / executionStats.sellVolume) * 100 : null;
  const executionStrengthTone =
    executionStrength == null || executionStrength === 100
      ? "text-neutral-400"
      : executionStrength > 100
        ? "text-red-400"
        : "text-blue-400";

  const maxQty = Math.max(
    1,
    ...(snap?.asks ?? []).map((l) => l.qty),
    ...(snap?.bids ?? []).map((l) => l.qty),
  );

  // 항상 8행씩 렌더해 호가 수가 변해도 컴포넌트 높이가 흔들리지 않게 고정
  const pad = (levels: Level[]): (Level | null)[] => [
    ...levels.slice(0, 8),
    ...Array<null>(Math.max(0, 8 - levels.length)).fill(null),
  ];

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900">
      <div className="border-b border-neutral-800 px-3 py-2 text-xs font-semibold text-neutral-400">
        <div className="flex items-center justify-between gap-2">
          <span>호가창</span>
          <span
            className={executionStrengthTone}
            title="체결강도 = (KST 당일 매수 체결량 ÷ 매도 체결량) × 100입니다. 100% 초과는 매수 우위, 미만은 매도 우위입니다."
          >
            체결강도 {executionStrength != null ? `${executionStrength.toFixed(1)}%` : "—"}
          </span>
        </div>
      </div>
      <div className="text-xs tabular-nums">
        {/* 매도(asks): 낮은 가격이 아래로 */}
        <div className="flex flex-col-reverse">
          {pad(snap?.asks ?? []).map((l, i) =>
            l ? (
              <Row
                key={`a${l.price}`}
                level={l}
                side="ask"
                maxQty={maxQty}
                change={depthChanges[`ask:${l.price}`]}
                onClick={onPriceClick}
              />
            ) : (
              <EmptyRow key={`a-empty-${i}`} />
            ),
          )}
        </div>
        <div className="border-y border-neutral-800 px-3 py-1.5 text-center text-sm font-bold text-neutral-100">
          {snap?.lastPrice != null ? fmt.format(snap.lastPrice) : "—"}
        </div>
        <div>
          {pad(snap?.bids ?? []).map((l, i) =>
            l ? (
              <Row
                key={`b${l.price}`}
                level={l}
                side="bid"
                maxQty={maxQty}
                change={depthChanges[`bid:${l.price}`]}
                onClick={onPriceClick}
              />
            ) : (
              <EmptyRow key={`b-empty-${i}`} />
            ),
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyRow() {
  return (
    <div className="flex w-full justify-between px-3 py-0.5 text-neutral-700">
      <span>&nbsp;</span>
    </div>
  );
}

function Row({
  level,
  side,
  maxQty,
  change,
  onClick,
}: {
  level: Level;
  side: "ask" | "bid";
  maxQty: number;
  change?: DepthChange;
  onClick?: (price: number) => void;
}) {
  const width = Math.max(2, (level.qty / maxQty) * 100);
  return (
    <button
      className={`relative flex w-full justify-between px-3 py-0.5 transition-colors hover:bg-neutral-800 ${
        change === "decrease" ? "bg-amber-400/15" : change === "increase" ? "bg-emerald-400/10" : ""
      }`}
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

function findDepthChanges(previous: Snapshot | null, next: Snapshot): Record<string, DepthChange> {
  if (!previous) return {};
  const changes: Record<string, DepthChange> = {};
  for (const [side, before, after] of [
    ["ask", previous.asks, next.asks],
    ["bid", previous.bids, next.bids],
  ] as const) {
    const previousQty = new Map(before.map((level) => [level.price, level.qty]));
    for (const level of after) {
      const beforeQty = previousQty.get(level.price);
      if (beforeQty == null || beforeQty === level.qty) continue;
      changes[`${side}:${level.price}`] = level.qty > beforeQty ? "increase" : "decrease";
    }
  }
  return changes;
}
