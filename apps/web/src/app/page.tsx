"use client";

import type { NewsItemDto } from "@mock-kabu/shared";
import { NEWS_FEED_SCOPE } from "@mock-kabu/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, fmt, getToken, getUser, won } from "@/lib/api";
import EquityChart from "@/components/EquityChart";
import { NewsList } from "@/components/NewsFeed";
import Sparkline from "@/components/Sparkline";
import { mergeNews, parseNewsItem } from "@/lib/news";
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
interface RealizedSummary {
  today: number;
  todayQty: number;
  total: number;
  totalQty: number;
}
interface MarketSummary {
  turnover: number | string | null;
  lastTradeTs: number | string | null;
}
interface CandleDto {
  ts: string;
  close: number;
}

/** 종목 표 미니 추세선: 5분봉 종가 최근 6시간(72개). 실시간 가격은 마지막 점을 대신한다. */
const SPARK_INTERVAL = "5m";
const SPARK_POINTS = 72;
const SPARK_REFRESH_MS = 5 * 60 * 1000;

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
  const [realized, setRealized] = useState<RealizedSummary | null>(null);
  const [symbols, setSymbols] = useState<SymbolRow[]>([]);
  const [livePrices, setLivePrices] = useState<Record<string, number>>({});
  const [turnovers, setTurnovers] = useState<Record<string, number>>({});
  const [news, setNews] = useState<NewsItemDto[]>([]);
  const [sparks, setSparks] = useState<Record<string, number[]>>({});
  const turnoverWatermarksRef = useRef(new Map<string, number>());
  const pendingTurnoverTicksRef = useRef(new Map<string, Map<string, TradeTick>>());

  const refreshAccount = useCallback(() => {
    api<AccountInfo>("/account").then(setAccount).catch(() => {});
    api<HoldingRow[]>("/account/holdings").then(setHoldings).catch(() => {});
    api<RealizedSummary>("/account/realized?limit=1").then(setRealized).catch(() => {});
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

  // The dashboard shows only the newest few; the news tab holds the full feed.
  useEffect(() => {
    let active = true;
    api<NewsItemDto[]>("/market/news?limit=5", { auth: false })
      .then((rows) => {
        if (active) setNews((previous) => mergeNews(previous, rows));
      })
      .catch(() => {});

    const unsubscribe = subscribe([`news:${NEWS_FEED_SCOPE}`], ({ data }) => {
      const item = parseNewsItem(data);
      if (item) setNews((previous) => mergeNews([item], previous).slice(0, 5));
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  // 추세선은 5분봉이라 5분마다만 다시 읽고, 그 사이는 실시간 가격으로 마지막 점만 움직인다.
  useEffect(() => {
    if (symbols.length === 0) return;
    let active = true;
    const load = () => {
      Promise.all(
        symbols.map(async ({ symbol }) => {
          const rows = await api<CandleDto[]>(
            `/market/candles/${symbol}?interval=${SPARK_INTERVAL}&limit=${SPARK_POINTS}`,
            { auth: false },
          ).catch(() => [] as CandleDto[]);
          return [symbol, rows.map((c) => c.close).filter((v) => Number.isFinite(v))] as const;
        }),
      ).then((entries) => {
        if (active) setSparks(Object.fromEntries(entries));
      });
    };
    load();
    const t = window.setInterval(load, SPARK_REFRESH_MS);
    return () => {
      active = false;
      window.clearInterval(t);
    };
  }, [symbols]);

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


  const hasHoldings = liveHoldings.length > 0;
  const pnlTone = totalPnl >= 0 ? "text-up" : "text-down";

  return (
    <div className="space-y-6">
      {/* ── Portfolio hero ─────────────────────────────────────── */}
      <section className="glass overflow-hidden">
        <div className="flex flex-col gap-6 p-5 sm:p-6 lg:flex-row lg:items-end lg:justify-between lg:gap-10">
          <div>
            <p className="panel-title">총 자산</p>
            <p className="num mt-2 text-4xl font-semibold tracking-tight sm:text-5xl">
              {won(total)}
            </p>
            <p className="num mt-2 text-sm font-medium">
              {hasHoldings ? (
                <>
                  <span className={pnlTone}>
                    {totalPnl >= 0 ? "▲" : "▼"} {totalPnl >= 0 ? "+" : ""}
                    {won(totalPnl)} ({totalPnl >= 0 ? "+" : ""}
                    {(totalPnlRate * 100).toFixed(2)}%)
                  </span>
                  <span className="ml-2 font-normal text-ink-faint">평가손익 · 전체 수익률</span>
                </>
              ) : (
                <span className="font-normal text-ink-faint">평가손익 —</span>
              )}
            </p>
          </div>

          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-5">
            <Metric label="현금 잔액" value={won(account?.balance ?? 0)} />
            <Metric label="주문 가능" value={won(account?.available ?? 0)} />
            <Metric label="주식 평가금액" value={won(stockValue)} />
            <Metric
              label="오늘 실현손익"
              value={realized ? signedWon(realized.today) : "—"}
              tone={realized ? toneOf(realized.today) : undefined}
              title="KST 당일 매도 체결에서 평단가 대비 확정된 손익"
            />
            <Metric
              label="누적 실현손익"
              value={realized ? signedWon(realized.total) : "—"}
              tone={realized ? toneOf(realized.total) : undefined}
              title="지금까지의 모든 매도 체결에서 확정된 손익 합계"
            />
          </dl>
        </div>

        {/* Allocation bar — cash vs. equity at a glance. */}
        {total > 0 && (
          <div className="border-t border-hairline-soft px-5 py-3 sm:px-6">
            <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-white/6">
              <div
                className="bg-sky/70"
                style={{ width: `${((account?.balance ?? 0) / total) * 100}%` }}
              />
              <div className="bg-indigo/70" style={{ width: `${(stockValue / total) * 100}%` }} />
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-muted">
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-sky/70" />
                현금 {(((account?.balance ?? 0) / total) * 100).toFixed(1)}%
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-indigo/70" />
                주식 {((stockValue / total) * 100).toFixed(1)}%
              </span>
            </div>
          </div>
        )}
      </section>

      {/* ── Equity curve ───────────────────────────────────────── */}
      <EquityChart />

      {/* ── Market ─────────────────────────────────────────────── */}
      <section className="glass overflow-hidden">
        <div className="panel-head">
          <span className="panel-title">종목</span>
          <span className="chip chip-live">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ok" />
            LIVE
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="tbl tbl-hover">
            <thead>
              <tr>
                <th>종목</th>
                <th className="text-right" title="모의 시장 시작 기준가">
                  기준가(시가)
                </th>
                <th className="text-right">현재가</th>
                <th className="text-right">등락률</th>
                <th className="text-right" title="KST 당일 누적 체결 금액을 만 원 단위로 표시">
                  거래대금 (만 원)
                </th>
                <th className="text-right" title="최근 6시간 5분봉 종가 흐름">
                  6시간 흐름
                </th>
                <th />
              </tr>
            </thead>
            <tbody>
              {liveSymbols.map((s) => {
                const change = ((s.lastPrice - s.initialPrice) / s.initialPrice) * 100;
                const tone = change > 0 ? "text-up" : change < 0 ? "text-down" : "text-ink-muted";
                return (
                  <tr key={s.symbol}>
                    <td>
                      <Link
                        href={`/symbol/${s.symbol}`}
                        className="flex items-center gap-2.5 transition-colors hover:text-sky"
                      >
                        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[9px] border border-hairline-soft bg-surface-2/70 text-[11px] font-semibold text-ink-muted">
                          {s.name.slice(0, 2)}
                        </span>
                        <span>
                          <span className="block font-semibold">{s.name}</span>
                          <span className="num block text-xs text-ink-faint">{s.symbol}</span>
                        </span>
                      </Link>
                    </td>
                    <td className="num text-right text-ink-muted">{fmt.format(s.initialPrice)}원</td>
                    <td className={`num text-right font-semibold ${tone}`}>
                      {fmt.format(s.lastPrice)}원
                    </td>
                    <td className={`num text-right ${tone}`}>
                      {change > 0 ? "+" : ""}
                      {change.toFixed(2)}%
                    </td>
                    <td className="num text-right">{formatTurnoverManWon(s.turnover)}</td>
                    <td className="text-right">
                      <SparkCell values={sparks[s.symbol]} livePrice={s.lastPrice} />
                    </td>
                    <td className="text-right">
                      <Link href={`/symbol/${s.symbol}`} className="btn btn-ghost btn-sm">
                        거래하기
                      </Link>
                    </td>
                  </tr>
                );
              })}
              {liveSymbols.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-sm text-ink-faint">
                    종목을 불러오는 중…
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Latest news ────────────────────────────────────────── */}
      <section className="glass overflow-hidden">
        <div className="panel-head">
          <span className="panel-title">최신 뉴스</span>
          <Link href="/news" className="text-[11px] text-ink-muted transition-colors hover:text-sky">
            전체 보기 →
          </Link>
        </div>
        <NewsList items={news} emptyLabel="아직 뉴스가 없습니다" />
      </section>

      {/* ── Holdings ───────────────────────────────────────────── */}
      <section className="glass overflow-hidden">
        <div className="panel-head">
          <span className="panel-title">보유 자산</span>
          {hasHoldings && (
            <span className="text-[11px] text-ink-faint">{liveHoldings.length}개 종목</span>
          )}
        </div>
        {!hasHoldings ? (
          <div className="px-5 py-12 text-center">
            <p className="text-sm text-ink-muted">보유 종목이 없습니다.</p>
            <p className="mt-1 text-xs text-ink-faint">
              위 목록에서 종목을 골라 첫 매수를 해보세요.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl tbl-hover">
              <thead>
                <tr>
                  <th>종목</th>
                  <th className="text-right">보유 수량</th>
                  <th className="text-right">매도 대기</th>
                  <th className="text-right">평단가</th>
                  <th className="text-right">현재가</th>
                  <th className="text-right">평가금액</th>
                  <th className="text-right">평가손익 (수익률)</th>
                </tr>
              </thead>
              <tbody>
                {liveHoldings.map((h) => (
                  <tr key={h.symbol}>
                    <td className="font-semibold">
                      <Link href={`/symbol/${h.symbol}`} className="hover:text-sky">
                        {h.symbol}
                      </Link>
                    </td>
                    <td className="num text-right">{fmt.format(h.qty)}</td>
                    <td className="num text-right text-ink-faint">{fmt.format(h.holdQty)}</td>
                    <td className="num text-right">{fmt.format(Math.round(h.avgCost))}</td>
                    <td className="num text-right">{fmt.format(h.lastPrice)}</td>
                    <td className="num text-right">{won(h.value)}</td>
                    <td
                      className={`num text-right font-medium ${h.pnl >= 0 ? "text-up" : "text-down"}`}
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

function SparkCell({ values, livePrice }: { values: number[] | undefined; livePrice: number }) {
  const series = values && values.length > 0 ? [...values.slice(0, -1), livePrice] : [];
  const first = series[0];
  const tone: "up" | "down" | "flat" =
    series.length < 2 || first == null || livePrice === first ? "flat" : livePrice > first ? "up" : "down";
  return (
    <span className="inline-block align-middle" title={series.length >= 2 ? `6시간 전 ${fmt.format(first)}원 → 현재 ${fmt.format(livePrice)}원` : undefined}>
      <Sparkline values={series} tone={tone} />
    </span>
  );
}

function signedWon(n: number): string {
  return `${n > 0 ? "+" : ""}${won(n)}`;
}

function toneOf(n: number): "up" | "down" | undefined {
  return n > 0 ? "up" : n < 0 ? "down" : undefined;
}

function Metric({
  label,
  value,
  tone,
  title,
}: {
  label: string;
  value: string;
  tone?: "up" | "down";
  title?: string;
}) {
  const color = tone === "up" ? "text-up" : tone === "down" ? "text-down" : "";
  return (
    <div
      title={title}
      className="border-l border-hairline-soft pl-4 first:border-l-0 first:pl-0 sm:border-l sm:pl-4"
    >
      <dt className="text-[11px] tracking-wide text-ink-muted uppercase">{label}</dt>
      <dd className={`num mt-1 text-base font-semibold whitespace-nowrap ${color}`}>{value}</dd>
    </div>
  );
}
