"use client";

import { useEffect, useRef, useState } from "react";
import { api, fmt, getToken, getUser } from "@/lib/api";
import { subscribe } from "@/lib/socket";
import { ACCOUNT_REFRESH_DEBOUNCE_MS, debounce } from "@/lib/debounce";

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

interface LiveOrderRow {
  side: "BUY" | "SELL";
  type: string;
  price: number | null;
  qty: number;
  filledQty: number;
}

/** 호가 단계별 내 미체결 잔량. 키는 "ask:{price}" / "bid:{price}". */
type MyDepth = Record<string, number>;

/**
 * 내 지정가 미체결을 호가창 위에 표시하기 위해 읽는다. 계정 push가 주 경로, 15초 폴백.
 * 로그인하지 않았으면 아무것도 하지 않는다.
 */
function useMyDepth(symbol: string): MyDepth {
  const [depth, setDepth] = useState<MyDepth>({});
  useEffect(() => {
    if (!getToken()) return;
    let active = true;
    setDepth({});
    const load = () => {
      api<LiveOrderRow[]>(`/orders?symbol=${symbol}&status=live&limit=200`)
        .then((rows) => {
          if (!active) return;
          const next: MyDepth = {};
          for (const row of rows) {
            if (row.price == null) continue;
            const key = `${row.side === "BUY" ? "bid" : "ask"}:${row.price}`;
            next[key] = (next[key] ?? 0) + Math.max(0, row.qty - row.filledQty);
          }
          setDepth(next);
        })
        .catch(() => {});
    };
    load();
    const user = getUser();
    const loadSoon = debounce(load, ACCOUNT_REFRESH_DEBOUNCE_MS);
    const unsub = user ? subscribe([`account:${user.accountId}`], () => loadSoon()) : () => {};
    const t = window.setInterval(load, 15_000);
    return () => {
      active = false;
      unsub();
      loadSoon.cancel();
      window.clearInterval(t);
    };
  }, [symbol]);
  return depth;
}

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
  /** 가격과 함께 그 단계의 방향(ask/bid)을 알려 준다 — 매도호가 클릭은 매수, 매수호가 클릭은 매도 의도가 보통이다. */
  onPriceClick?: (price: number, side: "ask" | "bid") => void;
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
  const myDepth = useMyDepth(symbol);

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

  // 보이는 10단 잔량 합으로 매수/매도 호가 불균형을 본다. 체결강도(과거 체결)와 달리 지금 대기 중인 힘이다.
  const bidDepth = (snap?.bids ?? []).reduce((sum, level) => sum + level.qty, 0);
  const askDepth = (snap?.asks ?? []).reduce((sum, level) => sum + level.qty, 0);
  const depthTotal = bidDepth + askDepth;
  const bidShare = depthTotal > 0 ? bidDepth / depthTotal : null;
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
                mine={myDepth[`ask:${l.price}`]}
                onClick={(price) => onPriceClick?.(price, "ask")}
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
                mine={myDepth[`bid:${l.price}`]}
                onClick={(price) => onPriceClick?.(price, "bid")}
              />
            ) : (
              <EmptyRow key={`b-empty-${i}`} />
            ),
          )}
        </div>
      </div>

      {bidShare != null && (
        <div
          className="num border-t border-hairline-soft px-4 py-2 text-[11px]"
          title="보이는 호가 10단의 매수 잔량 대 매도 잔량 비율입니다. 대기 중인 힘의 균형이며, 체결강도(이미 체결된 양)와는 다릅니다."
        >
          <div className="flex items-center justify-between text-ink-muted">
            <span className="text-up">매수 잔량 {fmt.format(bidDepth)}</span>
            <span className={bidShare > 0.55 ? "text-up" : bidShare < 0.45 ? "text-down" : "text-ink-faint"}>
              호가 균형 {(bidShare * 100).toFixed(0)} : {(100 - bidShare * 100).toFixed(0)}
            </span>
            <span className="text-down">매도 잔량 {fmt.format(askDepth)}</span>
          </div>
          <div className="mt-1 flex h-1 w-full overflow-hidden rounded-full bg-white/6">
            <div className="bg-up/70 transition-[width] duration-300" style={{ width: `${bidShare * 100}%` }} />
            <div className="bg-down/70 transition-[width] duration-300" style={{ width: `${(1 - bidShare) * 100}%` }} />
          </div>
        </div>
      )}
      <p className="border-t border-hairline-soft px-4 py-2 text-[11px] text-ink-faint">
        가격을 클릭하면 주문 폼에 입력됩니다 (매도호가→매수, 매수호가→매도)
        {Object.keys(myDepth).length > 0 && (
          <span className="ml-2 text-sky" title="내 미체결 지정가가 있는 호가 단계">
            ● 내 주문
          </span>
        )}
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
  mine,
  onClick,
}: {
  level: Level;
  side: "ask" | "bid";
  maxQty: number;
  change?: DepthChange;
  /** 이 단계에 걸린 내 미체결 잔량 */
  mine?: number;
  onClick?: (price: number) => void;
}) {
  const width = Math.max(2, (level.qty / maxQty) * 100);
  return (
    <button
      className={`group relative flex w-full items-center justify-between px-4 py-1 transition-colors hover:bg-white/6 ${
        change === "decrease" ? "bg-warn/12" : change === "increase" ? "bg-ok/10" : ""
      }`}
      onClick={() => onClick?.(level.price)}
      title={mine ? `내 미체결 ${fmt.format(mine)}주 · 클릭하면 주문 가격에 입력됩니다` : "클릭하면 주문 가격에 입력됩니다"}
    >
      {mine != null && mine > 0 && (
        <span
          className="absolute top-1/2 left-1 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-sky shadow-[0_0_6px_rgba(56,189,248,0.8)]"
          aria-label={`내 미체결 ${mine}주`}
        />
      )}
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
