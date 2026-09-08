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

// A market maker safely replaces a ladder rung-by-rung. Those intermediate
// snapshots are real, but rendering every one makes the depth panel cascade
// mechanically. Keep matching and trade ticks immediate; render only the
// newest snapshot collected during each short visual batch.
const ORDERBOOK_RENDER_BATCH_MS = 100;

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
  const orderbookFlushTimerRef = useRef<number | null>(null);
  const queuedOrderbookRef = useRef<Snapshot | null>(null);
  const orderbookBatchStartedAtRef = useRef<number | null>(null);
  const lastOrderbookSeqRef = useRef(0);
  const pendingTicksRef = useRef(new Map<string, TradeTick>());
  const summaryWatermarkRef = useRef<number | null>(null);

  useEffect(() => {
    let disposed = false;
    previousRef.current = null;
    queuedOrderbookRef.current = null;
    orderbookBatchStartedAtRef.current = null;
    lastOrderbookSeqRef.current = 0;
    pendingTicksRef.current.clear();
    summaryWatermarkRef.current = null;
    setExecutionStats(null);
    setDepthChanges({});
    api<Snapshot>(`/market/orderbook/${symbol}`, { auth: false })
      .then((initial) => {
        // A socket snapshot can win the initial REST race. Never replace a
        // newer received sequence with the older bootstrap response.
        if (initial.seq < lastOrderbookSeqRef.current) return;
        lastOrderbookSeqRef.current = initial.seq;
        if (queuedOrderbookRef.current && queuedOrderbookRef.current.seq <= initial.seq) {
          queuedOrderbookRef.current = null;
        }
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
    const flushOrderbook = () => {
      orderbookFlushTimerRef.current = null;
      orderbookBatchStartedAtRef.current = null;
      const next = queuedOrderbookRef.current;
      queuedOrderbookRef.current = null;
      if (!next || disposed) return;

      const previous = previousRef.current;
      const changes = findDepthChanges(previous, next);
      previousRef.current = next;
      setSnap(next);
      if (Object.keys(changes).length > 0) {
        setDepthChanges(changes);
        if (flashTimerRef.current != null) window.clearTimeout(flashTimerRef.current);
        flashTimerRef.current = window.setTimeout(() => setDepthChanges({}), 900);
      }
    };
    const queueOrderbook = (next: Snapshot) => {
      if (!Number.isSafeInteger(next.seq) || next.seq <= lastOrderbookSeqRef.current) return;
      lastOrderbookSeqRef.current = next.seq;
      queuedOrderbookRef.current = next;

      const now = Date.now();
      const batchStartedAt = orderbookBatchStartedAtRef.current ?? now;
      orderbookBatchStartedAtRef.current = batchStartedAt;
      const elapsed = now - batchStartedAt;
      const delay = Math.max(0, ORDERBOOK_RENDER_BATCH_MS - elapsed);
      if (orderbookFlushTimerRef.current == null) {
        orderbookFlushTimerRef.current = window.setTimeout(flushOrderbook, delay);
      }
    };
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
      if (channel === `orderbook:${symbol}`) queueOrderbook(data as Snapshot);
    });
    return () => {
      disposed = true;
      window.clearInterval(refreshTimer);
      unsubscribe();
      if (flashTimerRef.current != null) window.clearTimeout(flashTimerRef.current);
      if (orderbookFlushTimerRef.current != null) window.clearTimeout(orderbookFlushTimerRef.current);
    };
  }, [symbol]);

  const executionStrength =
    executionStats && executionStats.sellVolume > 0 ? (executionStats.buyVolume / executionStats.sellVolume) * 100 : null;
  const executionStrengthTone =
    executionStrength == null || executionStrength === 100
      ? "text-ink-muted"
      : executionStrength > 100
        ? "text-up"
        : "text-down";

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
    <div className="glass flex flex-col overflow-hidden">
      <div className="panel-head">
        <span className="panel-title">호가창</span>
        <span
          className={`num text-[11px] font-semibold ${executionStrengthTone}`}
          title="체결강도 = (KST 당일 매수 체결량 ÷ 매도 체결량) × 100입니다. 100% 초과는 매수 우위, 미만은 매도 우위입니다."
        >
          체결강도 {executionStrength != null ? `${executionStrength.toFixed(1)}%` : "—"}
        </span>
      </div>

      <div className="num flex flex-1 flex-col justify-center py-1 text-xs">
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

        <div className="my-1 flex items-baseline justify-center gap-2 border-y border-hairline-soft bg-white/3 px-4 py-2">
          <span className="text-[10px] tracking-wide text-ink-faint uppercase">체결가</span>
          <span className="text-base font-semibold">
            {snap?.lastPrice != null ? fmt.format(snap.lastPrice) : "—"}
          </span>
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

      <p className="border-t border-hairline-soft px-4 py-2 text-[11px] text-ink-faint">
        가격을 클릭하면 주문 폼에 입력됩니다
      </p>
    </div>
  );
}

function EmptyRow() {
  return <div className="px-4 py-1 text-transparent">&nbsp;</div>;
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
      className={`group relative flex w-full items-center justify-between px-4 py-1 transition-colors hover:bg-white/6 ${
        change === "decrease" ? "bg-warn/12" : change === "increase" ? "bg-ok/10" : ""
      }`}
      onClick={() => onClick?.(level.price)}
      title="클릭하면 주문 가격에 입력됩니다"
    >
      <span
        className={`absolute inset-y-px right-0 rounded-l-[3px] ${side === "ask" ? "bg-down/14" : "bg-up/14"}`}
        style={{ width: `${width}%` }}
      />
      <span className={`relative font-medium ${side === "ask" ? "text-down" : "text-up"}`}>
        {fmt.format(level.price)}
      </span>
      <span className="relative text-ink-muted">{fmt.format(level.qty)}</span>
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
