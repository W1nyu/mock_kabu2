"use client";

import { FUTURES, futureDef } from "@mock-kabu/shared";
import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import AssetNews from "@/components/AssetNews";
import FuturesBook from "@/components/FuturesBook";
import FuturesOrderPanel from "@/components/FuturesOrderPanel";
import FuturesOrderSheet from "@/components/FuturesOrderSheet";
import FuturesPositionPanel from "@/components/FuturesPositionPanel";
import { MobileTradeBar } from "@/components/MobileOrderSheet";
import UnitCandleChart from "@/components/UnitCandleChart";
import { api, getUser } from "@/lib/api";
import { changePct, fmtFuture, type FutureRow } from "@/lib/futures";
import { timeLeft } from "@/lib/options";
import { COMPACT_TRADE_QUERY, useMediaQuery } from "@/lib/media";
import { subscribe } from "@/lib/socket";
import { everyVisible } from "@/lib/visible-interval";

/**
 * 선물 거래 화면. PC는 왼쪽 차트·호가, 오른쪽 주문·포지션.
 * 폰은 현물 거래 화면처럼 시세 → 차트 → 내 포지션 순으로 두고, 호가·주문은 하단 매수/매도 버튼이 여는 시트에 둔다.
 */
export default function FuturePage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = use(params);
  const def = futureDef(symbol);
  const [row, setRow] = useState<FutureRow | null>(null);
  const [last, setLast] = useState<number | null>(null);
  const [priceHint, setPriceHint] = useState<{ price: number; seq: number } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const compact = useMediaQuery(COMPACT_TRADE_QUERY);
  const [sheet, setSheet] = useState<{ side: "BUY" | "SELL"; seq: number } | null>(null);
  const closeSheet = useCallback(() => setSheet(null), []);
  const [loggedIn, setLoggedIn] = useState(false);
  useEffect(() => setLoggedIn(getUser() != null), []);

  useEffect(() => {
    if (!def) return;
    let active = true;
    const load = () =>
      api<FutureRow[]>("/market/futures", { auth: false })
        .then((rows) => {
          const found = rows.find((r) => r.symbol === def.symbol) ?? null;
          if (active && found) setRow(found);
        })
        .catch(() => {});
    load();
    const stop = everyVisible(load, 15_000);
    const unsub = subscribe([`trades:${def.symbol}`], ({ data }) => {
      const price = Number((data as { price?: unknown })?.price);
      if (active && Number.isFinite(price)) setLast(price);
    });
    return () => {
      active = false;
      stop();
      unsub();
    };
  }, [def]);

  if (!def) {
    return (
      <div className="mx-auto max-w-3xl py-16 text-center text-sm text-ink-muted">
        없는 선물입니다. <Link href="/market" className="text-sky">증권으로 돌아가기</Link>
      </div>
    );
  }

  const price = last ?? row?.lastPrice ?? null;
  const change = changePct(price, row?.base);
  const basis = price != null && row?.underlying != null ? price - row.underlying : null;
  const tone = change == null ? "text-ink-faint" : change > 0 ? "text-up" : change < 0 ? "text-down" : "text-ink-muted";

  return (
    <div className="mx-auto max-w-6xl space-y-4 max-lg:pb-20">
      {/* 뒤로 가기(선물 목록)와 다른 선물로 바로 가는 칩 — 폰은 하단 탭이 숨어 있어 이 줄이 유일한 이동 경로다. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Link
          href="/market?kind=futures"
          className="inline-flex shrink-0 items-center gap-1.5 text-[13px] text-ink-muted transition-colors hover:text-sky"
        >
          <span aria-hidden>←</span> 선물 목록
        </Link>
        <nav aria-label="다른 선물" className="chip-scroller flex min-w-0 flex-1 gap-1.5 overflow-x-auto">
          {FUTURES.map((future) => (
            <Link
              key={future.symbol}
              href={`/futures/${future.symbol}`}
              aria-current={future.symbol === def.symbol ? "page" : undefined}
              className={`shrink-0 rounded-full px-3 py-1 text-[12px] font-medium whitespace-nowrap transition-colors ${
                future.symbol === def.symbol
                  ? "bg-sky/12 text-sky ring-1 ring-sky/30 ring-inset"
                  : "text-ink-muted ring-1 ring-hairline ring-inset hover:text-ink"
              }`}
            >
              {future.name.replace(" 선물", "")}
            </Link>
          ))}
        </nav>
      </div>
      <div className="glass p-4 sm:p-5">
        <p className="text-[13px] text-ink-muted">
          {def.symbol} · 1일물 선물{" "}
          <span className="text-ink-faint">
            · {row?.settlesAt ? `정산까지 ${timeLeft(row.settlesAt)} (04:10 현금 정산)` : "매일 04:10 현금 정산"}
          </span>
        </p>
        <h1 className="mt-1 text-xl font-semibold tracking-tight sm:text-2xl">{def.name}</h1>
        <div className="mt-2 flex flex-wrap items-end gap-x-5 gap-y-1">
          <p className="num text-2xl font-semibold tracking-tight sm:text-3xl">{fmtFuture(def.symbol, price)}</p>
          <p className={`num pb-1 text-sm font-medium ${tone}`}>
            {change == null ? "—" : `${change > 0 ? "+" : ""}${change.toFixed(2)}%`}
            <span className="ml-1 font-normal text-ink-faint">{row?.settlementPrice != null ? "전일 정산가 대비" : "오늘"}</span>
          </p>
        </div>
        <dl className="num mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[13px] text-ink-muted">
          <div>
            기초자산 <span className="text-ink">{fmtFuture(def.symbol, row?.underlying ?? null)}</span>
          </div>
          <div>
            베이시스 <span className="text-ink">{basis == null ? "—" : `${basis > 0 ? "+" : ""}${(basis / def.priceScale).toFixed(def.decimals)}`}</span>
          </div>
          <div title="등락률의 기준 — 직전 04:10 일일 정산 가격">
            기준가 <span className="text-ink">{fmtFuture(def.symbol, row?.base ?? null)}</span>
          </div>
          <div title="이번 계약(직전 정산 이후) 거래량">
            거래량 <span className="text-ink">{(row?.volume ?? 0).toLocaleString("ko-KR")}계약</span>
          </div>
        </dl>
      </div>

      {/* DOM 순서 = 폰 순서(차트 → 주문·포지션 → 호가). PC는 격자 위치로 왼쪽 차트·호가, 오른쪽 주문·포지션. */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px] lg:grid-rows-[auto_1fr]">
        <div className="lg:col-start-1 lg:row-start-1">
          <section className="glass p-3 sm:p-4">
            <UnitCandleChart
              candlesUrl={(interval, limit) => `/market/candles/${def.symbol}?interval=${interval}&limit=${limit}`}
              channel={`trades:${def.symbol}`}
              tickFrom={(data) => {
                const d = data as { price?: unknown; ts?: unknown };
                const value = Number(d?.price);
                const ts = Number(d?.ts);
                return Number.isFinite(value) && Number.isFinite(ts) ? { value, ts } : null;
              }}
              scale={def.priceScale}
              decimals={def.decimals}
            />
          </section>
        </div>
        <div className="space-y-4 lg:col-start-2 lg:row-span-2 lg:row-start-1">
          {!compact && (
            <FuturesOrderPanel
              symbol={def.symbol}
              lastPrice={price}
              priceHint={priceHint}
              onPlaced={() => setRefreshKey((k) => k + 1)}
            />
          )}
          <FuturesPositionPanel symbol={def.symbol} refreshKey={refreshKey} />
        </div>
        {!compact && (
          <div className="lg:col-start-1 lg:row-start-2 lg:self-start">
            <FuturesBook symbol={def.symbol} onPick={(p) => setPriceHint({ price: p, seq: Date.now() })} />
          </div>
        )}
      </div>

      {/* 주가지수 선물은 시장 전반 기사, 나머지는 그 기초자산을 움직인 기사 */}
      <AssetNews
        reference={def.underlying === "KABU_INDEX" ? "market" : def.underlying}
        title={def.underlying === "KABU_INDEX" ? "시장 뉴스" : "관련 뉴스"}
      />

      {compact && loggedIn && (
        <MobileTradeBar
          onOpen={(side) => {
            setPriceHint(null);
            setSheet({ side, seq: Date.now() });
          }}
        />
      )}
      {compact && !loggedIn && (
        <p className="text-center text-sm text-ink-muted">
          선물 주문은 <Link href="/login" className="text-sky">로그인</Link> 후 이용할 수 있습니다.
        </p>
      )}
      {compact && sheet && (
        <FuturesOrderSheet
          key={sheet.seq}
          symbol={def.symbol}
          name={def.name}
          side={sheet.side}
          lastPrice={price}
          priceHint={priceHint}
          onPick={(p) => setPriceHint({ price: p, seq: Date.now() })}
          onPlaced={() => setRefreshKey((k) => k + 1)}
          onClose={closeSheet}
        />
      )}
    </div>
  );
}
