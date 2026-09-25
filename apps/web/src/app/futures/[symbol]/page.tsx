"use client";

import { futureDef } from "@mock-kabu/shared";
import Link from "next/link";
import { use, useEffect, useState } from "react";
import FuturesBook from "@/components/FuturesBook";
import FuturesOrderPanel from "@/components/FuturesOrderPanel";
import FuturesPositionPanel from "@/components/FuturesPositionPanel";
import UnitCandleChart from "@/components/UnitCandleChart";
import { api } from "@/lib/api";
import { changePct, fmtFuture, type FutureRow } from "@/lib/futures";
import { subscribe } from "@/lib/socket";
import { everyVisible } from "@/lib/visible-interval";

/**
 * 선물 거래 화면. PC는 왼쪽 차트·호가, 오른쪽 주문·포지션. 폰은 위에서부터 시세 → 차트 → 주문 →
 * 포지션 → 호가 순으로 쌓아 한 손으로 내려가며 볼 수 있게 한다.
 */
export default function FuturePage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = use(params);
  const def = futureDef(symbol);
  const [row, setRow] = useState<FutureRow | null>(null);
  const [last, setLast] = useState<number | null>(null);
  const [priceHint, setPriceHint] = useState<{ price: number; seq: number } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

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
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="glass p-4 sm:p-5">
        <p className="text-[13px] text-ink-muted">
          {def.symbol} · 1일물 선물 <span className="text-ink-faint">· 매일 04:10 현금 정산</span>
        </p>
        <h1 className="mt-1 text-xl font-semibold tracking-tight sm:text-2xl">{def.name}</h1>
        <div className="mt-2 flex flex-wrap items-end gap-x-5 gap-y-1">
          <p className="num text-2xl font-semibold tracking-tight sm:text-3xl">{fmtFuture(def.symbol, price)}</p>
          <p className={`num pb-1 text-sm font-medium ${tone}`}>
            {change == null ? "—" : `${change > 0 ? "+" : ""}${change.toFixed(2)}% 오늘`}
          </p>
        </div>
        <dl className="num mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[13px] text-ink-muted">
          <div>
            기초자산 <span className="text-ink">{fmtFuture(def.symbol, row?.underlying ?? null)}</span>
          </div>
          <div>
            베이시스 <span className="text-ink">{basis == null ? "—" : `${basis > 0 ? "+" : ""}${(basis / def.priceScale).toFixed(def.decimals)}`}</span>
          </div>
          <div>
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
          <FuturesOrderPanel
            symbol={def.symbol}
            lastPrice={price}
            priceHint={priceHint}
            onPlaced={() => setRefreshKey((k) => k + 1)}
          />
          <FuturesPositionPanel symbol={def.symbol} refreshKey={refreshKey} />
        </div>
        <div className="lg:col-start-1 lg:row-start-2 lg:self-start">
          <FuturesBook symbol={def.symbol} onPick={(p) => setPriceHint({ price: p, seq: Date.now() })} />
        </div>
      </div>
    </div>
  );
}
