"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, fmt, getToken, getUser, won } from "@/lib/api";
import { subscribe } from "@/lib/socket";

interface AccountInfo {
  balance: number;
  holdAmount: number;
  available: number;
}
interface HoldingRow {
  symbol: string;
  qty: number;
  holdQty: number;
  availableQty: number;
  lastPrice: number;
  value: number;
  costBasis: number;
  avgCost: number;
  pnl: number;
  pnlRate: number;
}
interface SymbolRow {
  symbol: string;
  name: string;
  lastPrice: number;
  initialPrice: number;
}
interface MarketSummary {
  turnover: number | string | null;
  lastTradeTs: number | string | null;
}

function finiteNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

interface TradeTick {
  id: string;
  price: number;
  qty: number;
  ts: number;
}

function parseTradeTick(data: any): TradeTick | null {
  const price = finiteNumber(data?.price);
  const qty = finiteNumber(data?.qty);
  const ts = finiteNumber(data?.ts);
  if (price == null || qty == null || ts == null || qty < 0) return null;
  const id = typeof data?.tradeId === "string" ? data.tradeId : `${ts}:${price}:${qty}`;
  return { id, price, qty, ts };
}

function formatTurnoverManWon(turnover: number | undefined): string {
  if (turnover == null || !Number.isFinite(turnover)) return "—";
  return `${fmt.format(Math.round(turnover / 10_000))}만 원`;
}

export default function DashboardPage() {
  const router = useRouter();
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [holdings, setHoldings] = useState<HoldingRow[]>([]);
  const [symbols, setSymbols] = useState<SymbolRow[]>([]);
  const [livePrices, setLivePrices] = useState<Record<string, number>>({});
  const [turnovers, setTurnovers] = useState<Record<string, number>>({});
  const turnoverWatermarksRef = useRef(new Map<string, number>());
  const pendingTurnoverTicksRef = useRef(new Map<string, Map<string, TradeTick>>());

  const refreshAccount = useCallback(() => {
    api<AccountInfo>("/account").then(setAccount).catch(() => {});
    api<HoldingRow[]>("/account/holdings").then(setHoldings).catch(() => {});
  }, []);

  const refreshSymbols = useCallback(() => {
    api<SymbolRow[]>("/market/symbols", { auth: false })
      .then(async (rows) => {
        setSymbols(rows);
        const summaries = await Promise.all(
          rows.map(async ({ symbol }) => ({
            symbol,
            summary: await api<MarketSummary>(`/market/summary/${symbol}`, { auth: false }),
          })),
        );

        const nextTurnovers: Record<string, number> = {};
        for (const { symbol, summary } of summaries) {
          const watermark = finiteNumber(summary.lastTradeTs) ?? Number.NEGATIVE_INFINITY;
          const pending = pendingTurnoverTicksRef.current.get(symbol);
          let pendingTurnover = 0;
          if (pending) {
            for (const [id, tick] of pending) {
              if (tick.ts > watermark) pendingTurnover += tick.price * tick.qty;
              else pending.delete(id);
            }
          }
          nextTurnovers[symbol] = Math.max(0, finiteNumber(summary.turnover) ?? 0) + pendingTurnover;
          turnoverWatermarksRef.current.set(symbol, watermark);
        }
        // 스냅샷과 동시에 도착한 tick은 watermark 뒤의 것만 다시 더한다.
        setTurnovers(() => nextTurnovers);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!getToken()) {
      router.push("/login");
      return;
    }
    refreshAccount();
    refreshSymbols();
    const user = getUser();
    const unsub = user
      ? subscribe([`account:${user.accountId}`], () => refreshAccount())
      : () => {};
    // WebSocket push가 주 경로이며, 재연결 사이에 놓친 이벤트는 느린 폴백으로 보정한다.
    const fallback = window.setInterval(() => {
      refreshAccount();
      refreshSymbols();
    }, 15_000);
    return () => {
      window.clearInterval(fallback);
      unsub();
    };
  }, [refreshAccount, refreshSymbols, router]);

  useEffect(() => {
    const channels = symbols.map(({ symbol }) => `trades:${symbol}`);
    if (channels.length === 0) return;

    return subscribe(channels, ({ channel, data }) => {
      const tick = parseTradeTick(data);
      if (!tick) return;
      const symbol = channel.slice("trades:".length);
      let pending = pendingTurnoverTicksRef.current.get(symbol);
      if (!pending) {
        pending = new Map();
        pendingTurnoverTicksRef.current.set(symbol, pending);
      }
      if (pending.has(tick.id)) return;
      pending.set(tick.id, tick);

      setLivePrices((current) =>
        current[symbol] === tick.price ? current : { ...current, [symbol]: tick.price },
      );

      const watermark = turnoverWatermarksRef.current.get(symbol);
      if (watermark == null || tick.ts > watermark) {
        setTurnovers((current) => ({
          ...current,
          [symbol]: (current[symbol] ?? 0) + tick.price * tick.qty,
        }));
      }
    });
  }, [symbols]);

  const liveSymbols = useMemo(
    () =>
      symbols.map((symbol) => ({
        ...symbol,
        lastPrice: livePrices[symbol.symbol] ?? symbol.lastPrice,
        turnover: turnovers[symbol.symbol],
      })),
    [livePrices, symbols, turnovers],
  );
  const liveHoldings = useMemo(
    () =>
      holdings.map((holding) => {
        const lastPrice = livePrices[holding.symbol] ?? holding.lastPrice;
        const value = lastPrice * holding.qty;
        const pnl = value - holding.costBasis;
        return {
          ...holding,
          lastPrice,
          value,
          pnl,
          pnlRate: holding.costBasis > 0 ? pnl / holding.costBasis : 0,
        };
      }),
    [holdings, livePrices],
  );

  const stockValue = liveHoldings.reduce((sum, h) => sum + h.value, 0);
  const total = (account?.balance ?? 0) + stockValue;
  const totalCost = liveHoldings.reduce((sum, h) => sum + h.costBasis, 0);
  const totalPnl = liveHoldings.reduce((sum, h) => sum + h.pnl, 0);
  const totalPnlRate = totalCost > 0 ? totalPnl / totalCost : 0;

  return (
    <div className="space-y-6">
      <section className="grid grid-cols-2 gap-4 md:grid-cols-5">
        <Stat label="총 자산" value={won(total)} highlight />
        <Stat label="현금 잔액" value={won(account?.balance ?? 0)} />
        <Stat label="주문 가능" value={won(account?.available ?? 0)} />
        <Stat label="주식 평가금액" value={won(stockValue)} />
        <Stat
          label="평가손익 (전체 수익률)"
          value={
            holdings.length > 0
              ? `${totalPnl >= 0 ? "+" : ""}${won(totalPnl)} (${totalPnl >= 0 ? "+" : ""}${(totalPnlRate * 100).toFixed(2)}%)`
              : "—"
          }
          tone={holdings.length === 0 ? undefined : totalPnl >= 0 ? "up" : "down"}
        />
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-neutral-400">종목</h2>
        <div className="overflow-hidden rounded-lg border border-neutral-800">
          <table className="w-full text-sm">
            <thead className="bg-neutral-900 text-left text-neutral-400">
              <tr>
                <th className="px-4 py-2">종목</th>
                <th className="px-4 py-2 text-right" title="모의 시장 시작 기준가">
                  기준가(시가)
                </th>
                <th className="px-4 py-2 text-right">현재가</th>
                <th className="px-4 py-2 text-right">등락률</th>
                <th className="px-4 py-2 text-right" title="KST 당일 누적 체결 금액을 만 원 단위로 표시">
                  거래대금 (만 원)
                </th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {liveSymbols.map((s) => {
                const change = ((s.lastPrice - s.initialPrice) / s.initialPrice) * 100;
                return (
                  <tr key={s.symbol} className="border-t border-neutral-800 hover:bg-neutral-900">
                    <td className="px-4 py-2">
                      <span className="font-semibold">{s.symbol}</span>{" "}
                      <span className="text-neutral-400">{s.name}</span>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-neutral-300">
                      {fmt.format(s.initialPrice)}원
                    </td>
                    <td
                      className={`px-4 py-2 text-right tabular-nums font-medium ${change > 0 ? "text-red-400" : change < 0 ? "text-blue-400" : ""}`}
                    >
                      {fmt.format(s.lastPrice)}원
                    </td>
                    <td
                      className={`px-4 py-2 text-right tabular-nums ${change > 0 ? "text-red-400" : change < 0 ? "text-blue-400" : "text-neutral-400"}`}
                    >
                      {change > 0 ? "+" : ""}
                      {change.toFixed(2)}%
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-neutral-200">
                      {formatTurnoverManWon(s.turnover)}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Link
                        href={`/symbol/${s.symbol}`}
                        className="rounded bg-neutral-800 px-3 py-1 text-xs hover:bg-neutral-700"
                      >
                        거래하기
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-neutral-400">보유 자산</h2>
        {holdings.length === 0 ? (
          <p className="rounded-lg border border-neutral-800 p-4 text-sm text-neutral-500">
            보유 종목이 없습니다. 종목을 골라 첫 매수를 해보세요.
          </p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-neutral-800">
            <table className="w-full text-sm">
              <thead className="bg-neutral-900 text-left text-neutral-400">
                <tr>
                  <th className="px-4 py-2">종목</th>
                  <th className="px-4 py-2 text-right">보유 수량</th>
                  <th className="px-4 py-2 text-right">매도 대기</th>
                  <th className="px-4 py-2 text-right">평단가</th>
                  <th className="px-4 py-2 text-right">현재가</th>
                  <th className="px-4 py-2 text-right">평가금액</th>
                  <th className="px-4 py-2 text-right">평가손익 (수익률)</th>
                </tr>
              </thead>
              <tbody>
                {liveHoldings.map((h) => (
                  <tr key={h.symbol} className="border-t border-neutral-800">
                    <td className="px-4 py-2 font-semibold">
                      <Link href={`/symbol/${h.symbol}`} className="hover:text-amber-400">
                        {h.symbol}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{fmt.format(h.qty)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-neutral-400">
                      {fmt.format(h.holdQty)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {fmt.format(Math.round(h.avgCost))}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{fmt.format(h.lastPrice)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{won(h.value)}</td>
                    <td
                      className={`px-4 py-2 text-right tabular-nums ${h.pnl >= 0 ? "text-red-400" : "text-blue-400"}`}
                    >
                      {h.pnl >= 0 ? "+" : ""}
                      {won(h.pnl)} ({h.pnl >= 0 ? "+" : ""}
                      {(h.pnlRate * 100).toFixed(2)}%)
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  highlight,
  tone,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  tone?: "up" | "down";
}) {
  const color = highlight ? "text-amber-400" : tone === "up" ? "text-red-400" : tone === "down" ? "text-blue-400" : "";
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <p className="text-xs text-neutral-400">{label}</p>
      <p className={`mt-1 text-lg font-bold tabular-nums ${color}`}>{value}</p>
    </div>
  );
}
